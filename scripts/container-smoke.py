"""Exercise packaged media/ML dependencies without SQL, Ollama, or private data."""
import argparse
from io import BytesIO
import json


def check_media():
    from PIL import Image
    import fitz
    import pdfplumber
    from pypdf import PdfReader
    image = Image.new('RGB', (32, 24), 'red')
    encoded = BytesIO()
    image.save(encoded, format='JPEG')
    with Image.open(BytesIO(encoded.getvalue())) as decoded:
        assert decoded.size == (32, 24)
    document = fitz.open()
    document.new_page().insert_text((30, 30), 'Inspeksi Ubuntu 22.04')
    pdf = document.tobytes()
    document.close()
    assert len(PdfReader(BytesIO(pdf)).pages) == 1
    with pdfplumber.open(BytesIO(pdf)) as parsed:
        assert 'Inspeksi Ubuntu 22.04' in parsed.pages[0].extract_text()
    return ['image JPEG', 'PDF extraction', 'PDF text context']


def check_training():
    import numpy as np
    import onnx
    from onnx import helper, TensorProto
    import onnxruntime as ort
    import torch
    import torchvision
    import ultralytics
    import yaml
    from detector_worker import nms
    # Exercise compiled operators, not just imports: mismatched CPU wheels can
    # import successfully and still fail when torchvision.nms is first called.
    boxes = torch.tensor([[0., 0., 10., 10.], [1., 1., 9., 9.]])
    assert torchvision.ops.nms(boxes, torch.tensor([0.9, 0.8]), 0.5).tolist() == [0]
    assert nms(boxes.numpy(), np.array([0.9, 0.8]), np.array([0, 0])) == [0]
    graph = helper.make_graph([helper.make_node('Identity', ['x'], ['y'])], 'smoke',
                              [helper.make_tensor_value_info('x', TensorProto.FLOAT, [1])],
                              [helper.make_tensor_value_info('y', TensorProto.FLOAT, [1])])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    session = ort.InferenceSession(model.SerializeToString(), providers=['CPUExecutionProvider'])
    assert session.run(None, {'x': np.array([2.], dtype=np.float32)})[0].tolist() == [2.]
    assert yaml.safe_load('device: cpu')['device'] == 'cpu'
    return ['torch CPU', 'torchvision NMS', 'YOLO import', 'ONNX inference', 'YAML']


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--training', action='store_true')
    args = parser.parse_args()
    checks = check_training() if args.training else check_media()
    print(json.dumps({'ok': True, 'checks': checks}))
