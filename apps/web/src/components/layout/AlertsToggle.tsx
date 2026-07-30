import { useEffect } from 'react';
import { Button, Tooltip } from 'antd';
import { BellOutlined, BellFilled } from '@ant-design/icons';
import { requestNotificationPermission } from '../../hooks/useScreenerAlerts';
import { useAlertsArmed, setAlertsArmed, isAlertsArmed } from '../../hooks/useAlertsArmed';

// One-click affordance to (a) unlock the AudioContext (browsers require a user
// gesture before audio.play()), and (b) request Notification permission.
// State persists across reloads via localStorage so the user doesn't have to
// re-arm every time the dashboard reopens.
export function AlertsToggle() {
  // Shared state — useScreenerAlerts reads the same source, so the button
  // actually mutes the sound now (before, it only relabelled itself).
  const armed = useAlertsArmed();

  // On mount, drop the armed flag if notification permission was revoked in
  // browser settings since we last armed. Sound is gated on the same flag, so
  // this keeps the button honest: what it says is what you get.
  useEffect(() => {
    const granted = 'Notification' in window && Notification.permission === 'granted';
    if (isAlertsArmed() && !granted) setAlertsArmed(false);
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
    setAlertsArmed(true);
  };

  const disarm = () => setAlertsArmed(false);

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
