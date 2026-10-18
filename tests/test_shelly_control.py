import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

from app.devices import read_shelly_heater_output, set_shelly_heater_output


class ShellyOutputTests(unittest.TestCase):
    @patch("app.config.settings", SimpleNamespace(shelly_real_control_enabled=True,
          shelly_wiring_verified=True, shelly_cutoff_verified=True,
          shelly_restart_off_verified=False, shelly_output_id=0))
    def test_real_control_remains_blocked_until_safe_restart_is_verified(self):
        from app.config import shelly_real_control_ready
        self.assertFalse(shelly_real_control_ready())

    @patch("app.config.shelly_real_control_ready", return_value=False)
    @patch("app.devices.requests.post")
    def test_real_output_is_blocked_unless_all_safety_gates_are_armed(self, post, _ready):
        with self.assertRaisesRegex(RuntimeError, "bloquejat"):
            set_shelly_heater_output(True, 15)
        post.assert_not_called()

    @patch("app.config.shelly_real_control_ready", return_value=True)
    @patch("app.devices.requests.post")
    def test_on_command_carries_shelly_local_off_watchdog(self, post, _ready):
        response = Mock()
        response.json.return_value = {"was_on": False}
        post.return_value = response
        result = set_shelly_heater_output(True, 15)
        self.assertEqual(result, {"was_on": False})
        self.assertEqual(post.call_args.args[0], "http://10.85.3.202/rpc/Switch.Set")
        self.assertEqual(post.call_args.kwargs["json"],
                         {"id": 0, "on": True, "tag": "PanettoneLab", "toggle_after": 15})

    @patch("app.config.shelly_real_control_ready", return_value=True)
    @patch("app.devices.requests.get")
    def test_physical_state_is_read_back_from_switch_status(self, get, _ready):
        response = Mock()
        response.json.return_value = {"id": 0, "output": True}
        get.return_value = response
        self.assertIs(read_shelly_heater_output(), True)
        self.assertEqual(get.call_args.args[0], "http://10.85.3.202/rpc/Switch.GetStatus")
        self.assertEqual(get.call_args.kwargs["params"], {"id": 0})


if __name__ == "__main__":
    unittest.main()
