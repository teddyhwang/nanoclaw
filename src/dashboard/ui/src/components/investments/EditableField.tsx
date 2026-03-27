import { useRef } from 'react';
import { fmtFull } from '../../utils/format';
import { usePrivacy } from '../../contexts/PrivacyContext';

interface Props {
  value: number;
  onSave: (value: number) => void;
  className?: string;
}

export function EditableField({ value, onSave, className = 'editable' }: Props) {
  const { privacyMode } = usePrivacy();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <input
      ref={inputRef}
      className={className}
      defaultValue={fmtFull(value, privacyMode)}
      onFocus={() => {
        if (inputRef.current) {
          inputRef.current.value = String(value);
          inputRef.current.select();
        }
      }}
      onBlur={() => {
        if (inputRef.current) {
          const raw = parseFloat(inputRef.current.value.replace(/[$,]/g, '')) || 0;
          inputRef.current.value = fmtFull(raw, privacyMode);
          onSave(raw);
        }
      }}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.blur()}
    />
  );
}
