'use client';

/**
 * WATCH RULES — custom per-user alert rules UI.
 *
 * Create / edit / delete rules that push the user a browser notification when a
 * smart-money burst matches their conditions (wallets, min buyers, min SOL,
 * holding-only). Rules persist server-side via /api/watch-rules, keyed by the
 * same stable per-device `owner` id used by the watchlist + web-push (localStorage
 * `sm_owner_id`). Push is the only delivery channel today; Telegram is shown as
 * "link in bot" (owned by a separate flow).
 *
 * Resilient: if there's no owner (private mode) or the server is unconfigured,
 * the list is simply empty and writes degrade to no-ops — the UI never crashes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Plus, Trash2, Pencil, X } from 'lucide-react';
import { useWatchlist } from '@/lib/useWatchlist';
import { EmptyState, ErrorState } from '@/components/ui';

const OWNER_KEY = 'sm_owner_id';
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Stable per-device owner id (shared with the watchlist + push). */
function getOwnerId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    let id = window.localStorage.getItem(OWNER_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `sm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(OWNER_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

interface Rule {
  id: string | null;
  owner: string;
  label: string | null;
  wallets: string[];
  minBuyers: number;
  minSol: number;
  holdingOnly: boolean;
  channels: string[];
  muted: boolean;
  createdAt?: string;
}

interface DraftRule {
  id: string | null;
  label: string;
  walletsText: string;
  minBuyers: number;
  minSol: number;
  holdingOnly: boolean;
  pushEnabled: boolean;
  muted: boolean;
}

function blankDraft(): DraftRule {
  return {
    id: null,
    label: '',
    walletsText: '',
    minBuyers: 3,
    minSol: 0,
    holdingOnly: false,
    pushEnabled: true,
    muted: false,
  };
}

function ruleToDraft(r: Rule): DraftRule {
  return {
    id: r.id,
    label: r.label ?? '',
    walletsText: r.wallets.join('\n'),
    minBuyers: r.minBuyers,
    minSol: r.minSol,
    holdingOnly: r.holdingOnly,
    pushEnabled: r.channels.includes('push'),
    muted: r.muted,
  };
}

/** Parse the wallets textarea: split on whitespace/commas, keep valid addresses. */
function parseWallets(text: string): { valid: string[]; invalid: number } {
  const tokens = text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const valid: string[] = [];
  let invalid = 0;
  const seen = new Set<string>();
  for (const t of tokens) {
    if (ADDRESS_RE.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        valid.push(t);
      }
    } else {
      invalid += 1;
    }
  }
  return { valid, invalid };
}

export default function WatchRules() {
  const { watchlist } = useWatchlist();
  const [owner, setOwner] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setOwner(getOwnerId());
  }, []);

  const load = useCallback(async (ownerId: string) => {
    try {
      const res = await fetch(`/api/watch-rules?owner=${encodeURIComponent(ownerId)}`);
      if (!res.ok) throw new Error('Failed to load rules');
      const json = (await res.json()) as { rules?: Rule[] };
      setRules(Array.isArray(json.rules) ? json.rules : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!owner) {
      // No stable identity (private mode / disabled storage) → nothing to load.
      if (owner === null && typeof window !== 'undefined') setLoading(false);
      return;
    }
    setLoading(true);
    void load(owner);
  }, [owner, load]);

  const startNew = () => {
    setFormError(null);
    setDraft(blankDraft());
  };
  const startEdit = (r: Rule) => {
    setFormError(null);
    setDraft(ruleToDraft(r));
  };
  const cancelEdit = () => {
    setDraft(null);
    setFormError(null);
  };

  const save = async () => {
    if (!draft || !owner) return;
    const { valid, invalid } = parseWallets(draft.walletsText);
    if (invalid > 0) {
      setFormError(`${invalid} line${invalid === 1 ? '' : 's'} aren't valid Solana addresses — fix or remove them.`);
      return;
    }
    const channels = draft.pushEnabled ? ['push'] : [];
    if (channels.length === 0) {
      setFormError('Pick at least one delivery channel (Push).');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch('/api/watch-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner,
          id: draft.id ?? undefined,
          label: draft.label.trim() || undefined,
          wallets: valid,
          minBuyers: draft.minBuyers,
          minSol: draft.minSol,
          holdingOnly: draft.holdingOnly,
          channels,
          muted: draft.muted,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to save rule');
      }
      setDraft(null);
      await load(owner);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string | null) => {
    if (!id || !owner) return;
    // Optimistic removal; reload on failure.
    const prev = rules;
    setRules((rs) => rs.filter((r) => r.id !== id));
    try {
      const res = await fetch('/api/watch-rules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, id }),
      });
      if (!res.ok) throw new Error('delete failed');
    } catch {
      setRules(prev); // restore on failure
    }
  };

  const toggleMute = async (r: Rule) => {
    if (!r.id || !owner) return;
    const next = !r.muted;
    setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, muted: next } : x)));
    try {
      await fetch('/api/watch-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner,
          id: r.id,
          label: r.label ?? undefined,
          wallets: r.wallets,
          minBuyers: r.minBuyers,
          minSol: r.minSol,
          holdingOnly: r.holdingOnly,
          channels: r.channels,
          muted: next,
        }),
      });
    } catch {
      setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, muted: !next } : x)));
    }
  };

  const head = (
    <div className="page-head">
      <div className="sub">
        {rules.length} alert rule{rules.length !== 1 ? 's' : ''}
      </div>
      {!draft && (
        <div className="page-head-actions">
          <button type="button" className="btn primary sm" onClick={startNew}>
            <Plus size={15} /> New rule
          </button>
        </div>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="view stack gap-24">
        {head}
        <div className="card">
          <p className="faint" style={{ padding: 16 }}>Loading rules…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="view stack gap-24">
      {head}

      {error && (
        <div className="card">
          <ErrorState msg="Couldn’t load your alert rules." />
        </div>
      )}

      {draft && (
        <RuleForm
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={cancelEdit}
          saving={saving}
          formError={formError}
          watchlist={watchlist}
        />
      )}

      {!draft && !error && rules.length === 0 && (
        <div className="card">
          <EmptyState
            icon={Bell}
            title="No alert rules yet"
            msg="Create a rule to get a browser push when smart-money buys a token — filtered to specific wallets and burst size. Use “New rule” above; enable browser alerts in the Live feed first."
          />
        </div>
      )}

      {!error && rules.length > 0 && (
        <div className="stack gap-12">
          {rules.map((r) => (
            <RuleCard
              key={r.id ?? r.label ?? Math.random()}
              rule={r}
              onEdit={() => startEdit(r)}
              onDelete={() => remove(r.id)}
              onToggleMute={() => toggleMute(r)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RuleCard({
  rule,
  onEdit,
  onDelete,
  onToggleMute,
}: {
  rule: Rule;
  onEdit: () => void;
  onDelete: () => void;
  onToggleMute: () => void;
}) {
  const walletSummary =
    rule.wallets.length === 0
      ? 'Any wallet'
      : `${rule.wallets.length} wallet${rule.wallets.length === 1 ? '' : 's'}`;

  return (
    <div className="card" style={{ padding: 16, opacity: rule.muted ? 0.6 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div className="stack gap-8" style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong>{rule.label || 'Untitled rule'}</strong>
            {rule.muted && <span className="tier" style={{ fontSize: 11 }}>MUTED</span>}
          </div>
          <div className="sub" style={{ fontSize: 13 }}>
            {walletSummary} · ≥ {rule.minBuyers} buyer{rule.minBuyers === 1 ? '' : 's'}
            {rule.minSol > 0 ? ` · ≥ ${rule.minSol} SOL` : ''}
            {rule.holdingOnly ? ' · watchlist only' : ''}
          </div>
          <div className="sub" style={{ fontSize: 12 }}>
            Channels:{' '}
            {rule.channels.includes('push') ? 'Push' : ''}
            {rule.channels.includes('telegram') ? ' · Telegram (link in bot)' : ''}
            {rule.channels.length === 0 ? 'none' : ''}
          </div>
        </div>
        <div className="row-actions" style={{ flexShrink: 0 }}>
          <button type="button" className="btn sm" onClick={onToggleMute} title={rule.muted ? 'Unmute' : 'Mute'}>
            {rule.muted ? 'Unmute' : 'Mute'}
          </button>
          <button type="button" className="btn sm" onClick={onEdit} title="Edit">
            <Pencil size={14} />
          </button>
          <button type="button" className="btn sm" onClick={onDelete} title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  formError,
  watchlist,
}: {
  draft: DraftRule;
  setDraft: (d: DraftRule) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  formError: string | null;
  watchlist: string[];
}) {
  const set = <K extends keyof DraftRule>(k: K, v: DraftRule[K]) => setDraft({ ...draft, [k]: v });
  const parsed = useMemo(() => parseWallets(draft.walletsText), [draft.walletsText]);

  const addWatchlist = () => {
    const have = new Set(parsed.valid);
    const toAdd = watchlist.filter((w) => !have.has(w));
    if (toAdd.length === 0) return;
    const joined = [draft.walletsText.trim(), ...toAdd].filter(Boolean).join('\n');
    set('walletsText', joined);
  };

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <strong>{draft.id ? 'Edit rule' : 'New rule'}</strong>
        <button type="button" className="btn sm" onClick={onCancel} title="Cancel">
          <X size={14} />
        </button>
      </div>

      <div className="stack gap-12">
        <label className="stack gap-8">
          <span className="sub" style={{ fontSize: 13 }}>Label (optional)</span>
          <input
            type="text"
            value={draft.label}
            maxLength={80}
            placeholder="e.g. S-tier whales aping"
            onChange={(e) => set('label', e.target.value)}
            style={inputStyle}
          />
        </label>

        <label className="stack gap-8">
          <span className="sub" style={{ fontSize: 13 }}>
            Wallets (one per line; leave empty to match any smart-money wallet)
          </span>
          <textarea
            value={draft.walletsText}
            rows={4}
            placeholder="Paste wallet addresses…"
            onChange={(e) => set('walletsText', e.target.value)}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span className="sub" style={{ fontSize: 12 }}>
              {parsed.valid.length} valid{parsed.invalid > 0 ? ` · ${parsed.invalid} invalid` : ''}
            </span>
            {watchlist.length > 0 && (
              <button type="button" className="btn sm" onClick={addWatchlist}>
                + Add my watchlist ({watchlist.length})
              </button>
            )}
          </div>
        </label>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label className="stack gap-8" style={{ flex: 1, minWidth: 140 }}>
            <span className="sub" style={{ fontSize: 13 }}>Min buyers</span>
            <input
              type="number"
              min={0}
              max={1000}
              value={draft.minBuyers}
              onChange={(e) => set('minBuyers', Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))))}
              style={inputStyle}
            />
          </label>
          <label className="stack gap-8" style={{ flex: 1, minWidth: 140 }}>
            <span className="sub" style={{ fontSize: 13 }}>Min SOL</span>
            <input
              type="number"
              min={0}
              step="0.1"
              value={draft.minSol}
              onChange={(e) => set('minSol', Math.max(0, Number(e.target.value) || 0))}
              style={inputStyle}
            />
          </label>
        </div>

        <label style={checkboxRow}>
          <input
            type="checkbox"
            checked={draft.holdingOnly}
            onChange={(e) => set('holdingOnly', e.target.checked)}
          />
          <span className="sub" style={{ fontSize: 13 }}>
            Only wallets on my watchlist
          </span>
        </label>

        <div className="stack gap-8">
          <span className="sub" style={{ fontSize: 13 }}>Channels</span>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={draft.pushEnabled}
              onChange={(e) => set('pushEnabled', e.target.checked)}
            />
            <span className="sub" style={{ fontSize: 13 }}>
              Browser / desktop push (enable alerts in the Live feed first)
            </span>
          </label>
          <label style={{ ...checkboxRow, opacity: 0.6 }}>
            <input type="checkbox" checked disabled />
            <span className="sub" style={{ fontSize: 13 }}>
              Telegram — link your account in the bot
            </span>
          </label>
        </div>

        <label style={checkboxRow}>
          <input type="checkbox" checked={draft.muted} onChange={(e) => set('muted', e.target.checked)} />
          <span className="sub" style={{ fontSize: 13 }}>Muted (saved but won’t fire)</span>
        </label>

        {formError && <p className="neg" style={{ fontSize: 13 }}>{formError}</p>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn primary sm" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create rule'}
          </button>
          <button type="button" className="btn sm" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--surface-2, #1a1a1a)',
  border: '1px solid var(--border, #333)',
  borderRadius: 8,
  padding: '8px 10px',
  color: 'inherit',
  width: '100%',
};

const checkboxRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
};
