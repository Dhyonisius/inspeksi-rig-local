import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import runtime_process


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ContainerCompatibilityTests(unittest.TestCase):
    def test_linux_worker_lock_only_reclaims_a_missing_pid(self):
        with patch.object(runtime_process.os, 'name', 'posix'):
            with patch.object(runtime_process.os, 'kill'):
                self.assertTrue(runtime_process.process_alive(123))
            with patch.object(runtime_process.os, 'kill', side_effect=ProcessLookupError):
                self.assertFalse(runtime_process.process_alive(123))
            with patch.object(runtime_process.os, 'kill', side_effect=PermissionError):
                self.assertTrue(runtime_process.process_alive(123))
        for pid in (0, -1, '123'):
            with self.assertRaises(ValueError):
                runtime_process.process_alive(pid)

    def test_draft_worker_uses_configured_ollama_service(self):
        with patch.dict(os.environ, {'OLLAMA_BASE_URL': 'http://ollama.internal:11434/', 'OLLAMA_VISION_MODEL': 'vision:test'}):
            module = load('annotation_worker_test', 'annotate-rig-drafts.py')
        self.assertEqual(module.MODEL, 'vision:test')
        with patch.object(module.urllib.request, 'urlopen') as open_request:
            open_request.return_value.__enter__.return_value = io.BytesIO(b'{"models":[]}')
            self.assertEqual(module.request('/api/tags'), {'models': []})
            self.assertEqual(open_request.call_args.args[0].full_url, 'http://ollama.internal:11434/api/tags')

    def test_preparation_uses_image_interpreters_without_package_install(self):
        module = load('detector_prepare_test', 'prepare-detector.py')
        with patch.dict(os.environ, {'DETECTOR_PYTHON_EXE': '/opt/training/bin/python', 'RIG_TRAINING_PYTHON_EXE': '/opt/training/bin/python'}):
            with patch.object(module, 'run') as run:
                module.install()
                self.assertEqual(len(run.call_args_list), 2)
                for call in run.call_args_list:
                    self.assertEqual(str(call.args[0][0]), str(Path('/opt/training/bin/python')))
                    self.assertEqual(call.args[0][1], '-c')


if __name__ == '__main__':
    unittest.main()
