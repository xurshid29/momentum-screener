import { useEffect, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { BellOutlined, BellFilled } from '@ant-design/icons';
import { requestNotificationPermission } from '../../hooks/useScreenerAlerts';

// One-click affordance to (a) unlock the AudioContext (browsers require a user
// gesture before audio.play()), and (b) request Notification permission.
// Both are needed for useScreenerAlerts to be effective.
export function AlertsToggle() {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      // We still need a user gesture to unlock AudioContext, so don't auto-arm.
    }
  }, []);

  const handle = async () => {
    // Unlock audio context with a silent oscillator ping.
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ac = new Ctx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + 0.05);
    } catch {
      // ignore
    }
    requestNotificationPermission();
    setArmed(true);
  };

  return (
    <Tooltip title={armed ? 'Alerts armed' : 'Click to enable sound + browser notifications'}>
      <Button
        size="small"
        type={armed ? 'primary' : 'default'}
        icon={armed ? <BellFilled /> : <BellOutlined />}
        onClick={handle}
      >
        {armed ? 'Armed' : 'Arm alerts'}
      </Button>
    </Tooltip>
  );
}
