import { useId } from 'react';
import './brain-setting-switch.css';

interface BrainSettingSwitchProps {
  label: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onChange: (selected: boolean) => void;
}

/** Keep the same focusable DOM node throughout an asynchronous settings save. */
export function BrainSettingSwitch({ label, description, selected, disabled = false, onChange }: BrainSettingSwitchProps) {
  const descriptionId = useId();
  return <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={selected}
    aria-disabled={disabled}
    aria-describedby={description ? descriptionId : undefined}
    className="brain-setting-switch"
    onClick={() => { if (!disabled) onChange(!selected); }}
  >
    <span className="brain-setting-switch-track" data-slot="switch-control" aria-hidden="true"><span /></span>
    <span className="brain-setting-switch-copy">
      <span className="brain-setting-switch-label">{label}</span>
      {description && <span id={descriptionId} className="brain-setting-switch-description">{description}</span>}
    </span>
  </button>;
}
