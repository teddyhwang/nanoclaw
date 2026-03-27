import type { Account } from '../../types';
import { normType } from '../../utils/accounts';
import { fmt, fmtFull } from '../../utils/format';
import { usePrivacy } from '../../contexts/PrivacyContext';

const TYPE_ORDER = ['cash', 'investment', 'credit', 'other'] as const;
const TYPE_LABELS: Record<string, string> = {
  cash: 'Cash & Checking',
  investment: 'Investments',
  credit: 'Credit Cards',
  other: 'Other',
};

interface Props {
  accounts: Account[];
}

export function AccountsPanel({ accounts }: Props) {
  const { privacyMode } = usePrivacy();

  const grouped: Record<string, Account[]> = {};
  for (const a of accounts) {
    const t = normType(a.type);
    (grouped[t] ||= []).push(a);
  }

  return (
    <div className="panel accounts-panel">
      <div className="panel-head">Accounts</div>
      <div className="accounts-scroll">
        {TYPE_ORDER.map((type) => {
          const accts = grouped[type];
          if (!accts?.length) return null;
          let groupTotal = 0;
          return (
            <div key={type}>
              <div className="acct-group-label">{TYPE_LABELS[type] || type}</div>
              {accts.map((a) => {
                const b = a.to_base != null ? a.to_base : parseFloat(a.balance);
                groupTotal += b;
                let name = a.display_name || a.name || '—';
                if (a.institution_name && name.startsWith(a.institution_name))
                  name = name.slice(a.institution_name.length).replace(/^\s+/, '');
                return (
                  <div key={a.id} className="acct-row">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="acct-name">{name}</div>
                    </div>
                    <span className={`acct-bal t-${type}`}>
                      {fmtFull(parseFloat(a.balance), privacyMode, a.currency)}
                    </span>
                  </div>
                );
              })}
              <div className="acct-group-total">
                <span className="agl">
                  {accts.length} account{accts.length > 1 ? 's' : ''}
                </span>
                <span className="agv">{fmt(groupTotal, privacyMode)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
