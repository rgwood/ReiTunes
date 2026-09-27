import type { Comparison, SmartRule } from '../types';

const fields = [['duration', 'Duration'], ['duration_known', 'Duration known'], ['artist', 'Artist'], ['album', 'Album'], ['name', 'Title'], ['play_count', 'Play count'], ['added_within', 'Date added'], ['favourite', 'Favourite'], ['bookmarks', 'Bookmarks']];
const comparisons: [Comparison, string][] = [['lt', 'is less than'], ['lte', 'is at most'], ['eq', 'is'], ['gte', 'is at least'], ['gt', 'is greater than']];

function newRule(field = 'duration'): SmartRule {
  switch (field) {
    case 'artist': case 'album': case 'name': return { type: 'text', field, comparison: 'contains', value: '' };
    case 'duration_known': case 'favourite': case 'bookmarks': return { type: field, value: true };
    case 'play_count': return { type: field, comparison: 'eq', value: 0 };
    case 'added_within': return { type: field, days: 30 };
    default: return { type: 'duration', comparison: 'lt', seconds: 600 };
  }
}

export function SmartRulesEditor({ rule, onChange, onRemove, depth = 0 }: {
  rule: SmartRule; onChange: (rule: SmartRule) => void; onRemove?: () => void; depth?: number;
}) {
  if (rule.type === 'all' || rule.type === 'any') {
    return <fieldset className="smart-rule-group">
      <legend><span className="smart-rule-heading"><span>Match <select aria-label="Match rules" value={rule.type}
        onChange={event => onChange({ ...rule, type: event.target.value as 'all' | 'any' })}>
        <option value="all">all (AND)</option><option value="any">any (OR)</option>
      </select> of these rules</span>
        {onRemove ? <button type="button" onClick={onRemove}>Remove group</button>
          : rule.rules.length > 0 && <button type="button" onClick={() => onChange({ type: 'all', rules: [] })}>Clear rules</button>}
      </span></legend>
      {rule.rules.map((child, index) => <SmartRulesEditor key={index} rule={child} depth={depth + 1}
        onChange={next => onChange({ ...rule, rules: rule.rules.map((existing, i) => i === index ? next : existing) })}
        onRemove={() => onChange({ ...rule, rules: rule.rules.filter((_, i) => i !== index) })} />)}
      {!rule.rules.length && <p className="tracklist-help">{rule.type === 'all' ? 'No restrictions — matches every track.' : 'Add a rule to match tracks.'}</p>}
      <div className="smart-rule-actions">
        <button type="button" disabled={rule.rules.length >= 20} onClick={() => onChange({ ...rule, rules: [...rule.rules, newRule()] })}>Add rule</button>
        {depth < 3 && <button type="button" disabled={rule.rules.length >= 20} onClick={() => onChange({ ...rule, rules: [...rule.rules, { type: rule.type === 'all' ? 'any' : 'all', rules: [newRule('artist')] }] })}>Add group</button>}
      </div>
    </fieldset>;
  }
  return <div className="smart-rule-row">
    <select aria-label="Rule field" value={rule.type === 'text' ? rule.field : rule.type} onChange={event => onChange(newRule(event.target.value))}>
      {fields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    {rule.type === 'text' && <>
      <select aria-label="Text comparison" value={rule.comparison} onChange={event => onChange({ ...rule, comparison: event.target.value as typeof rule.comparison })}>
        <option value="contains">contains</option><option value="does_not_contain">does not contain</option><option value="is">is</option><option value="is_not">is not</option>
      </select>
      <input aria-label="Text value" required maxLength={200} value={rule.value} onChange={event => onChange({ ...rule, value: event.target.value })} />
    </>}
    {(rule.type === 'duration' || rule.type === 'play_count') && <>
      <select aria-label="Number comparison" value={rule.comparison} onChange={event => onChange({ ...rule, comparison: event.target.value as Comparison })}>
        {comparisons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input aria-label={rule.type === 'duration' ? 'Duration in minutes' : 'Play count value'} type="number" required min={0}
        step={rule.type === 'duration' ? 'any' : 1} value={rule.type === 'duration' ? rule.seconds / 60 : rule.value}
        onChange={event => onChange(rule.type === 'duration' ? { ...rule, seconds: Number(event.target.value) * 60 } : { ...rule, value: Number(event.target.value) })} />
      {rule.type === 'duration' && <span>minutes</span>}
    </>}
    {rule.type === 'added_within' && <><span>in the last</span><input aria-label="Days since added" type="number" required min={1} max={3650} value={rule.days}
      onChange={event => onChange({ ...rule, days: Number(event.target.value) })} /><span>days</span></>}
    {(rule.type === 'duration_known' || rule.type === 'favourite' || rule.type === 'bookmarks') && <select aria-label="Rule value" value={String(rule.value)} onChange={event => onChange({ ...rule, value: event.target.value === 'true' })}>
      <option value="true">Yes</option><option value="false">No</option>
    </select>}
    <button type="button" aria-label="Remove rule" title="Remove rule" onClick={onRemove}>×</button>
  </div>;
}
