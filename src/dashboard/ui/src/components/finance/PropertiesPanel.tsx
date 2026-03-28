import { useRef } from 'react';
import type { Account, Property } from '../../types';
import { normType } from '../../utils/accounts';
import { fmt, fmtFull } from '../../utils/format';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { Panel } from '@/components/shared';

interface Props {
  properties: Property[];
  accounts: Account[];
  onSaveProperty: (idx: number, value: number) => void;
}

export function PropertiesPanel({ properties, accounts, onSaveProperty }: Props) {
  const { privacyMode } = usePrivacy();
  const propTotal = properties.reduce((s, p) => s + p.value, 0);
  const loans = accounts.filter((a) => normType(a.type) === 'loan');

  // Sort loans to match property order
  const sortedLoans = [...loans].sort((a, b) => {
    const findIdx = (name: string) => {
      const n = (name || '').toLowerCase();
      return properties.findIndex((p) =>
        p.name
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length > 3 && n.includes(w)),
      );
    };
    const ai = findIdx(a.display_name || '');
    const bi = findIdx(b.display_name || '');
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  let loanTotal = 0;
  for (const l of sortedLoans) {
    loanTotal += Math.abs(l.to_base != null ? l.to_base : parseFloat(l.balance));
  }

  return (
    <Panel className="properties-panel" title="Properties">
      <div className="properties-list">
        <div className="prop-section-label">Valuations</div>
        {properties.map((p, i) => (
          <PropertyRow
            key={i}
            property={p}
            idx={i}
            privacyMode={privacyMode}
            onSave={onSaveProperty}
          />
        ))}
        <div className="prop-total">
          <span className="prop-name">{properties.length} properties</span>
          <span className="prop-val" style={{ color: 'var(--text-hi)' }}>
            {fmt(propTotal, privacyMode)}
          </span>
        </div>

        {sortedLoans.length > 0 && (
          <>
            <div className="prop-section-label">Mortgages</div>
            {sortedLoans.map((l) => {
              const bal = Math.abs(l.to_base != null ? l.to_base : parseFloat(l.balance));
              let name = l.display_name || '';
              if (l.institution_name && name.startsWith(l.institution_name))
                name = name.slice(l.institution_name.length).replace(/^\s+/, '');
              name = name.replace(/^LINE OF CREDIT\s*-\s*/i, '');
              return (
                <div key={l.id} className="prop-row">
                  <span className="prop-name">{name}</span>
                  <span className="prop-val" style={{ color: 'var(--red)' }}>
                    {fmtFull(-bal, privacyMode)}
                  </span>
                </div>
              );
            })}
            <div className="prop-total">
              <span className="prop-name">{loans.length} loans</span>
              <span className="prop-val" style={{ color: 'var(--red)' }}>
                {fmt(-loanTotal, privacyMode)}
              </span>
            </div>
            <div className="prop-total">
              <span className="prop-name">Net Equity</span>
              <span className="prop-val" style={{ color: 'var(--green)' }}>
                {fmt(propTotal - loanTotal, privacyMode)}
              </span>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function PropertyRow({
  property,
  idx,
  privacyMode,
  onSave,
}: {
  property: Property;
  idx: number;
  privacyMode: boolean;
  onSave: (idx: number, value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFocus = () => {
    if (inputRef.current) {
      inputRef.current.value = String(property.value);
      inputRef.current.select();
    }
  };

  const handleBlur = () => {
    if (inputRef.current) {
      const raw = parseFloat(inputRef.current.value.replace(/[$,]/g, '')) || 0;
      inputRef.current.value = fmtFull(raw, privacyMode);
      onSave(idx, raw);
    }
  };

  return (
    <div className="prop-row">
      <span className="prop-name">{property.name}</span>
      <input
        ref={inputRef}
        className="prop-edit"
        defaultValue={fmtFull(property.value, privacyMode)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.blur()}
      />
    </div>
  );
}
