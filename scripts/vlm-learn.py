"""Bounded CPU LoRA experiment. Images are NEVER deleted by the trainer."""
import argparse,gc,hashlib,json,math,os,sys,threading,time
from pathlib import Path
os.environ['CUDA_VISIBLE_DEVICES']='';os.environ['TOKENIZERS_PARALLELISM']='false';os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
MODEL='HuggingFaceTB/SmolVLM-256M-Instruct'
def atomic(file,data):
    tmp=file.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8');tmp.replace(file)
def main(jobfile):
    job=json.loads(jobfile.read_text(encoding='utf8'));out=Path(job['output']);out.mkdir(parents=True,exist_ok=True);status=out/'progress.json'
    def event(stage,**values):atomic(status,{'stage':stage,'time':time.time(),**values});print(json.dumps({'stage':stage,**values}),flush=True)
    try:
        import psutil
        started=time.monotonic();parent=job.get('parent_pid')
        def guard():
            while True:
                try:
                    if time.monotonic()-started>900 or psutil.Process().memory_info().rss>2300*1024**2 or psutil.virtual_memory().available<650*1024**2 or (parent and not psutil.pid_exists(parent)):
                        event('FAILED',error='Batas waktu/RAM tercapai atau server berhenti; foto tetap disimpan.',rss_mb=round(psutil.Process().memory_info().rss/1024**2),available_mb=round(psutil.virtual_memory().available/1024**2),elapsed=round(time.monotonic()-started));os._exit(4)
                except Exception:pass
                time.sleep(2)
        threading.Thread(target=guard,daemon=True).start()
        event('LOADING',model=MODEL,device='cpu',cpu_threads=2)
        import torch
        torch.set_num_threads(2);torch.set_num_interop_threads(1);torch.manual_seed(47)
        from PIL import Image
        Image.MAX_IMAGE_PIXELS=40000000
        from transformers import AutoProcessor,AutoModelForVision2Seq
        from peft import LoraConfig,get_peft_model,PeftModel
        cache=job['cache'];os.environ['HF_HOME']=cache;processor=AutoProcessor.from_pretrained(MODEL,cache_dir=cache)
        processor.image_processor.size={'longest_edge':512};processor.image_processor.do_image_splitting=False
        def base():return AutoModelForVision2Seq.from_pretrained(MODEL,torch_dtype=torch.float32,attn_implementation='eager',cache_dir=cache)
        model=base();previous=job.get('previous_adapter')
        if previous:model=PeftModel.from_pretrained(model,previous,is_trainable=not job.get('predict'))
        else:
            targets=[name for name,_ in model.named_modules() if ('text_model' in name or 'language_model' in name) and name.endswith(('q_proj','v_proj'))]
            if not targets:raise ValueError('Lapisan LoRA teks tidak ditemukan.')
            model=get_peft_model(model,LoraConfig(r=4,lora_alpha=8,lora_dropout=0.0,target_modules=targets,bias='none',task_type='CAUSAL_LM'))
        model.config.use_cache=False
        if job.get('predict'):
            model.eval();image=Image.open(job['image']).convert('RGB');image.thumbnail((512,512))
            if job.get('task')=='DUMMY_READINESS_CLASSIFICATION':
                question='Classify the simulated equipment image. Is it READY or NOT_READY? Answer only READY or NOT_READY.'
                user=[{'role':'user','content':[{'type':'image'},{'type':'text','text':question}]}];prefix=processor.apply_chat_template(user,add_generation_prompt=True)
                prompt=processor(text=prefix,images=[image],return_tensors='pt');scores={}
                with torch.no_grad():
                    for label in job['labels']:
                        full=user+[{'role':'assistant','content':[{'type':'text','text':label}]}];text=processor.apply_chat_template(full,add_generation_prompt=False);inputs=processor(text=text,images=[image],return_tensors='pt');target=inputs['input_ids'].clone();target[:,:prompt['input_ids'].shape[-1]]=-100;target[target==processor.tokenizer.pad_token_id]=-100;scores[label]=float(model(**inputs,labels=target).loss)
                atomic(out/'prediction.json',{'answer':min(scores,key=scores.get),'scores':scores,'model':MODEL,'task':job['task'],'adapter':previous,'experimental':True});event('PREDICTED');return
            messages=[{'role':'user','content':[{'type':'image'},{'type':'text','text':'Describe the equipment and recorded inspection facts. Return the source facts, do not infer safety beyond them.'}]}]
            prompt=processor.apply_chat_template(messages,add_generation_prompt=True);inputs=processor(text=prompt,images=[image],return_tensors='pt')
            with torch.no_grad():generated=model.generate(**inputs,max_new_tokens=80,do_sample=False,repetition_penalty=1.15,no_repeat_ngram_size=3)
            answer=processor.decode(generated[0][inputs['input_ids'].shape[-1]:],skip_special_tokens=True)
            atomic(out/'prediction.json',{'answer':answer,'model':MODEL,'adapter':previous,'experimental':True});event('PREDICTED');return
        params=[p for p in model.parameters() if p.requires_grad]
        before=[p.detach().clone() for p in params]
        rows=job['samples'];classification=job.get('dummy',False)
        if classification:
            for row in rows:row['expected_label']=json.loads(row['target'])['source_status']
            labels=sorted(set(row['expected_label'] for row in rows))
            if labels!=['NOT_READY','READY']:raise ValueError('Batch dummy harus berisi READY dan NOT_READY agar evaluasi tidak hanya satu kelas.')
            validation=[next(row for row in reversed(rows) if row['expected_label']==label) for label in labels]
            held={r['key'] for r in validation};train=[r for r in rows if r['key'] not in held]
        else:train=rows[:-2];validation=rows[-2:];labels=[]
        if len(train)<2:raise ValueError('Minimal 4 foto diperlukan; 2 disisihkan untuk evaluasi.')
        question='Classify the simulated equipment image. Is it READY or NOT_READY? Answer only READY or NOT_READY.' if classification else 'Describe the equipment and recorded inspection facts. Return the source facts, do not infer safety beyond them.'
        def batch(row,forced_label=None):
            image=Image.open(row['image']).convert('RGB');image.thumbnail((512,512))
            user=[{'role':'user','content':[{'type':'image'},{'type':'text','text':question}]}]
            answer=(forced_label or row['expected_label']) if classification else row['target']
            full=user+[{'role':'assistant','content':[{'type':'text','text':answer}]}]
            prefix=processor.apply_chat_template(user,add_generation_prompt=True)
            text=processor.apply_chat_template(full,add_generation_prompt=False)
            inputs=processor(text=text,images=[image],return_tensors='pt')
            prompt=processor(text=prefix,images=[image],return_tensors='pt')
            labels=inputs['input_ids'].clone();labels[:,:prompt['input_ids'].shape[-1]]=-100
            labels[labels==processor.tokenizer.pad_token_id]=-100
            return {**inputs,'labels':labels}
        def evaluate():
            model.eval();values=[]
            with torch.no_grad():
                for row in validation:values.append(float(model(**batch(row)).loss))
            return sum(values)/len(values)
        def classify(row):
            model.eval()
            with torch.no_grad():scores={label:float(model(**batch(row,label)).loss) for label in labels}
            return min(scores,key=scores.get)
        baseline=evaluate();baseline_predictions=[classify(r) for r in validation] if classification else []
        if classification:
            groups=[[r for r in train if r['expected_label']==label] for label in labels]
            if any(not group for group in groups):raise ValueError('Kedua kelas harus tersedia untuk latihan dan evaluasi.')
            balanced=[group[i%len(group)] for i in range(max(map(len,groups))) for group in groups];train_order=balanced*(2 if previous else 6)
        else:train_order=train*3
        event('TRAINING',steps=0,total=len(train_order),baseline_validation_loss=baseline)
        optimizer=torch.optim.AdamW(params,lr=2e-4)
        model.train();losses=[]
        for index,row in enumerate(train_order):
            model.train();optimizer.zero_grad(set_to_none=True);loss=model(**batch(row)).loss
            if not torch.isfinite(loss):raise ValueError('Loss tidak terbatas; model tidak diterima.')
            loss.backward();torch.nn.utils.clip_grad_norm_(params,1.0);optimizer.step();losses.append(float(loss.detach()))
            if index%5==0 or index+1==len(train_order):event('TRAINING',steps=index+1,total=len(train_order),loss=losses[-1],baseline_validation_loss=baseline)
        changed=any(not torch.equal(old,param.detach()) for old,param in zip(before,params));del before,optimizer;gc.collect()
        final=evaluate()
        if not changed or not math.isfinite(final) or final>=baseline:raise ValueError(f'Checkpoint belum diterima: validation loss {baseline:.5f} -> {final:.5f}. Foto tetap disimpan.')
        predictions=[classify(r) for r in validation] if classification else []
        semantic_passed=classification and all(answer==row['expected_label'] for answer,row in zip(predictions,validation))
        if not semantic_passed:raise ValueError('Uji jawaban visual dua kelas belum lulus; foto tetap disimpan. Prediksi: '+str(predictions))
        checkpoint=out/'adapter';model.save_pretrained(checkpoint,safe_serialization=True);processor.save_pretrained(checkpoint)
        weights=checkpoint/'adapter_model.safetensors';checksum=hashlib.sha256(weights.read_bytes()).hexdigest()
        del model,params;gc.collect()
        model=PeftModel.from_pretrained(base(),checkpoint);model.config.use_cache=False;reloaded=evaluate()
        if not math.isfinite(reloaded) or abs(reloaded-final)>0.02:raise ValueError('Uji muat ulang checkpoint tidak cocok; foto tetap disimpan.')
        reloaded_predictions=[classify(r) for r in validation]
        if reloaded_predictions!=predictions:raise ValueError('Jawaban berubah setelah muat ulang checkpoint; foto tetap disimpan.')
        result={'accepted':True,'model':MODEL,'task':'DUMMY_READINESS_CLASSIFICATION','labels':labels,'semantic_evaluation':{'passed':True,'expected':[r['expected_label'] for r in validation],'predictions':predictions,'baseline_predictions':baseline_predictions,'sample_count':len(validation)},'adapter':str(checkpoint),'adapter_sha256':checksum,'baseline_validation_loss':baseline,'validation_loss':final,'reloaded_validation_loss':reloaded,'weights_changed':changed,'trained_keys':[r['key'] for r in train],'held_out_keys':[r['key'] for r in validation],'sample_count':len(rows),'dummy':job['dummy'],'device':'cpu','cpu_threads':2,'note':'Eksperimen klasifikasi READY/NOT_READY pada diagram dummy; bukan bukti akurasi keselamatan operasional.'}
        atomic(out/'result.json',result);event('ACCEPTED',**result)
    except Exception as error:
        event('FAILED',error=str(error)[:1500]);raise
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('job',type=Path);a=p.parse_args();main(a.job)
