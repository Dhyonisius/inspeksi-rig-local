const test=require('node:test'),assert=require('node:assert/strict');
const {check}=require('./protect-api-check.cjs');
const env={PROTECT_USERNAME:'TEST-ACCOUNT',PROTECT_PASSWORD:'not-a-real-password'};
test('missing credentials make no network request',async()=>{assert.equal(await check({env:{},log:()=>{},fetchImpl:()=>{throw Error('must not call');}}),2);});
test('login and rigs follow documented API without logging secrets',async()=>{
 const calls=[],logs=[];const code=await check({env,log:s=>logs.push(s),fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?Response.json({jwtToken:'fake-test-jwt',expiresIn:43200}):Response.json({status:'success',data:[{rigCode:'TEST'}]});}});
 assert.equal(code,0);assert.equal(calls[0].options.redirect,'manual');assert.equal(JSON.parse(calls[0].options.body).username,'test-account');assert.equal(calls[1].options.headers.Authorization,'Bearer fake-test-jwt');assert.equal(calls[1].options.headers['Ocp-Apim-Subscription-Key'],'NULL');assert.match(logs.join(' '),/Jumlah rig pada respons: 1/);assert.doesNotMatch(logs.join(' '),/fake-test-jwt|not-a-real-password|rigCode/);
});
test('MFA stops before data access',async()=>{let calls=0;assert.equal(await check({env,log:()=>{},fetchImpl:async()=>{calls++;return Response.json({mfacode:'challenge',jwtToken:'fake-test-jwt'});}}),2);assert.equal(calls,1);});
test('login failure is not retried or logged verbatim',async()=>{const logs=[];let calls=0;assert.equal(await check({env,log:s=>logs.push(s),fetchImpl:async()=>{calls++;return new Response('sensitive error',{status:401});}}),1);assert.equal(calls,1);assert.doesNotMatch(logs.join(' '),/sensitive error/);});
