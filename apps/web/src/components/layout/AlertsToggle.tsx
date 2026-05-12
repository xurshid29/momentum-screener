import { useEffect, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { BellOutlined, BellFilled } from '@ant-design/icons';
import { requestNotificationPermission } from '../../hooks/useScreenerAlerts';

const STORAGE_KEY = 'alerts.armed';

// One-click affordance to (a) unlock the AudioContext (browsers require a user
// gesture before audio.play()), and (b) request Notification permission.
// State persists across reloads via localStorage so the user doesn't have to
// re-arm every time the dashboard reopens.
export function AlertsToggle() {
  const [armed, setArmed] = useState<boolean>(false);

  // On mount: armed only if we previously armed AND notification permission is
  // still granted. (User may have revoked it in browser settings.)
  useEffect(() => {
    const persisted = localStorage.getItem(STORAGE_KEY) === '1';
    const granted = 'Notification' in window && Notification.permission === 'granted';
    setArmed(persisted && granted);
  }, []);

  const arm = () => {
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
    localStorage.setItem(STORAGE_KEY, '1');
    setArmed(true);
  };

  const disarm = () => {
    localStorage.removeItem(STORAGE_KEY);
    setArmed(false);
  };

  const tooltip = armed
    ? 'Alerts ON — click to disable'
    : 'Alerts OFF — click to enable sound + browser notifications';

  return (
    <Tooltip title={tooltip}>
      <Button
        size="small"
        icon={armed ? <BellFilled /> : <BellOutlined />}
        onClick={armed ? disarm : arm}
        style={
          armed
            ? { background: '#237804', borderColor: '#237804', color: '#fff' }
            : { background: '#a8071a', borderColor: '#a8071a', color: '#fff' }
        }
      >
        {armed ? 'Alerts ON' : 'Alerts OFF'}
      </Button>
    </Tooltip>
  );
}
