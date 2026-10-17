import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.fermenter import _switch_state, decide_simulated_output, schedule_state


class SimulatedControllerTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "mode": "automatic", "target_c": 27.0, "hysteresis_c": 0.3,
            "min_switch_seconds": 60, "max_on_seconds": 1800, "overtemp_c": 35.0,
            "continuous": 1, "schedule_enabled": 0, "schedule_start": "00:00",
            "schedule_end": "23:59", "manual_on": 0,
        }
        self.runtime = {"simulated_heater_on": 0, "heater_on_since": None,
                        "last_switch_at": None, "lockout_reason": None}
        self.now = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)

    def test_automatic_on_below_hysteresis_band(self):
        output, reason, lockout = decide_simulated_output(self.config, self.runtime, 26.7, True, self.now)
        self.assertTrue(output)
        self.assertEqual(reason, "Demanda simulada")
        self.assertIsNone(lockout)

    def test_automatic_retains_state_inside_hysteresis_band(self):
        self.runtime["simulated_heater_on"] = 1
        output, _, _ = decide_simulated_output(self.config, self.runtime, 27.1, True, self.now)
        self.assertTrue(output)

    def test_automatic_off_above_hysteresis_band(self):
        self.runtime["simulated_heater_on"] = 1
        output, _, _ = decide_simulated_output(self.config, self.runtime, 27.3, True, self.now)
        self.assertFalse(output)

    def test_invalid_sensor_forces_off(self):
        self.runtime["simulated_heater_on"] = 1
        output, reason, _ = decide_simulated_output(self.config, self.runtime, 25, False, self.now)
        self.assertFalse(output)
        self.assertIn("Sensor", reason)

    def test_overtemperature_forces_off_and_latches(self):
        self.runtime["simulated_heater_on"] = 1
        output, _, lockout = decide_simulated_output(self.config, self.runtime, 35.0, True, self.now)
        self.assertFalse(output)
        self.assertEqual(lockout, "overtemperature")

    def test_maximum_continuous_time_forces_off_and_latches(self):
        self.runtime.update(simulated_heater_on=1, heater_on_since="2026-10-17T11:29:59+00:00")
        output, _, lockout = decide_simulated_output(self.config, self.runtime, 26, True, self.now)
        self.assertFalse(output)
        self.assertEqual(lockout, "max_on_time")

    def test_minimum_switch_time_delays_only_normal_transition(self):
        self.runtime["last_switch_at"] = "2026-10-17T11:59:30+00:00"
        output, reason, _ = decide_simulated_output(self.config, self.runtime, 26, True, self.now)
        self.assertFalse(output)
        self.assertIn("temps mínim", reason)
        output, _, _ = decide_simulated_output(self.config, self.runtime, 40, False, self.now)
        self.assertFalse(output)

    def test_manual_and_stopped_modes(self):
        self.config.update(mode="manual", manual_on=1)
        self.assertTrue(decide_simulated_output(self.config, self.runtime, 27, True, self.now)[0])
        self.config["mode"] = "stopped"
        self.assertFalse(decide_simulated_output(self.config, self.runtime, 25, True, self.now)[0])

    def test_overnight_schedule(self):
        config = {"continuous": 0, "schedule_enabled": 1,
                  "schedule_start": "20:00", "schedule_end": "08:00"}
        madrid = ZoneInfo("Europe/Madrid")
        active = schedule_state(config, datetime(2026, 10, 17, 23, 0, tzinfo=madrid))
        inactive = schedule_state(config, datetime(2026, 10, 17, 12, 0, tzinfo=madrid))
        self.assertTrue(active["allowed"])
        self.assertFalse(inactive["allowed"])

    def test_unreported_physical_output_is_unknown_not_off(self):
        self.assertIsNone(_switch_state({}, "switch:0"))
        self.assertIsNone(_switch_state({"switch:0": {"output": None}}, "switch:0"))
        self.assertIs(_switch_state({"switch:0": {"output": False}}, "switch:0"), False)
        self.assertIs(_switch_state({"switch:0": {"output": True}}, "switch:0"), True)


if __name__ == "__main__":
    unittest.main()
