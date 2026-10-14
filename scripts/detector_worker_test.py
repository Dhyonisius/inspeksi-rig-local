import unittest
from io import BytesIO
import numpy as np
from PIL import Image
from detector_worker import detect, nms


class FakeSession:
    def get_inputs(self):
        return [type("Input", (), {"name": "images"})()]

    def run(self, unused, inputs):
        assert inputs["images"].shape == (1, 3, 640, 640)
        output = np.zeros((1, 21, 8400), dtype=np.float32)
        # A box in the middle of a1000x500 image letterboxed with160px vertical padding.
        output[0, :4, 0] = [320, 320, 320, 160]
        output[0, 14, 0] = .9  # helmet class10
        output[0, :4, 1] = [320, 320, 320, 160]
        output[0, 4, 1] = .8  # person class0 must survive class-awareNMS
        output[0, :4, 2] = [321, 320, 320, 160]
        output[0, 14, 2] = .7  # second helmet suppressed
        return [output]


class WorkerTests(unittest.TestCase):
    def test_letterbox_coordinates_return_to_oriented_source(self):
        image = BytesIO()
        Image.new("RGB", (1000, 500), "white").save(image, "JPEG")
        rows = detect(FakeSession(), image.getvalue())
        self.assertEqual([row["class_name"] for row in rows], ["helmet", "person"])
        self.assertEqual(rows[0]["box"], {"x": .25, "y": .25, "width": .5, "height": .5})

    def test_nms_is_class_aware_and_limited(self):
        boxes = np.array([[0, 0, 10, 10], [0, 0, 10, 10], [0, 0, 10, 10]], dtype=float)
        self.assertEqual(nms(boxes, np.array([.9, .8, .7]), np.array([0, 1, 0])), [0, 1])
        self.assertEqual(nms(boxes, np.array([.9, .8, .7]), np.array([0, 1, 0]), max_detections=1), [0])

    def test_invalid_image_fails_instead_of_returning_a_safe_label(self):
        with self.assertRaises(Exception):
            detect(FakeSession(), b"not an image")


if __name__ == "__main__":
    unittest.main()
