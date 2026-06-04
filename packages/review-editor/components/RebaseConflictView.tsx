import React from 'react';

export type RebaseConflictChoice = 'ours' | 'theirs' | 'both' | 'manual';

export interface RebaseConflictDecision {
  choice: RebaseConflictChoice;
  note?: string;
}

export interface RebaseConflictBlock {
  id: string;
  filePath: string;
  index: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  theirs: string[];
}

interface RebaseConflictViewProps {
  conflicts: RebaseConflictBlock[];
  decisions: Record<string, RebaseConflictDecision>;
  onDecisionChange: (conflictId: string, decision: RebaseConflictDecision) => void;
}

function stripPatchLine(line: string): string {
  if (line.startsWith('\\ No newline')) return '';
  if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) return line.slice(1);
  return line;
}

export function parseRebaseConflicts(rawPatch: string): RebaseConflictBlock[] {
  const conflicts: RebaseConflictBlock[] = [];
  const chunks = rawPatch.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+) b\/(.+)/);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];
    let current: RebaseConflictBlock | null = null;
    let side: 'ours' | 'theirs' | null = null;
    let conflictIndex = 0;

    for (const patchLine of lines) {
      if (!patchLine || patchLine.startsWith('diff --git ') || patchLine.startsWith('index ') || patchLine.startsWith('--- ') || patchLine.startsWith('+++ ') || patchLine.startsWith('@@')) {
        continue;
      }

      const content = stripPatchLine(patchLine);
      if (content.startsWith('<<<<<<<')) {
        conflictIndex += 1;
        current = {
          id: `${filePath}:${conflictIndex}`,
          filePath,
          index: conflictIndex,
          oursLabel: content.replace(/^<<<<<<<\s*/, '') || 'HEAD',
          theirsLabel: 'incoming',
          ours: [],
          theirs: [],
        };
        side = 'ours';
        continue;
      }

      if (current && content.startsWith('=======')) {
        side = 'theirs';
        continue;
      }

      if (current && content.startsWith('>>>>>>>')) {
        current.theirsLabel = content.replace(/^>>>>>>>\s*/, '') || current.theirsLabel;
        conflicts.push(current);
        current = null;
        side = null;
        continue;
      }

      if (!current || !side) continue;
      current[side].push(content);
    }
  }

  return conflicts;
}

export function formatRebaseDecisionFeedback(
  conflicts: RebaseConflictBlock[],
  decisions: Record<string, RebaseConflictDecision>,
): string {
  const selected = conflicts.filter((conflict) => decisions[conflict.id]);
  if (selected.length === 0) return '';

  const lines = ['## Rebase conflict choices'];
  for (const conflict of selected) {
    const decision = decisions[conflict.id];
    lines.push('', `- \`${conflict.filePath}\` conflict ${conflict.index}: **${decision.choice}**`);
    if (decision.note?.trim()) {
      lines.push(`  - Note: ${decision.note.trim()}`);
    }
  }

  return lines.join('\n');
}

const CHOICE_LABELS: Array<{ choice: RebaseConflictChoice; label: string; description: string }> = [
  { choice: 'ours', label: '✅ Accept current', description: 'Use the HEAD/current side for this conflict.' },
  { choice: 'theirs', label: '✅ Accept incoming', description: 'Use the commit-being-replayed side for this conflict.' },
  { choice: 'both', label: '✅ Keep both', description: 'Combine both sides; agent should preserve both intent blocks.' },
  { choice: 'manual', label: '✏️ Manual', description: 'Needs manual merge guidance.' },
];

function CodeBlock({ label, lines, selected }: { label: string; lines: string[]; selected: boolean }) {
  return (
    <div className={`rounded-lg border overflow-hidden transition-all ${selected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-muted/20'}`}>
      <div className={`px-3 py-2 text-xs font-medium flex items-center justify-between ${selected ? 'text-primary bg-primary/10' : 'text-muted-foreground bg-muted/30'}`}>
        <span>{label}</span>
        {selected && <span aria-label="selected">✅</span>}
      </div>
      <pre className="m-0 p-3 overflow-x-auto text-xs leading-relaxed font-mono text-foreground whitespace-pre-wrap">
        {lines.length > 0 ? lines.join('\n') : <span className="text-muted-foreground italic">empty block</span>}
      </pre>
    </div>
  );
}

export function RebaseConflictView({ conflicts, decisions, onDecisionChange }: RebaseConflictViewProps) {
  if (conflicts.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        No conflict markers were found in the rebase diff.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="max-w-5xl mx-auto px-6 py-5 space-y-5">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="text-base font-semibold text-foreground">Rebase conflict review</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Pick the side to keep for each conflict. These choices are sent to the agent as guidance; Plannotator will not edit files or continue the rebase automatically.
          </p>
        </div>

        {conflicts.map((conflict) => {
          const decision = decisions[conflict.id];
          return (
            <section key={conflict.id} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">{conflict.filePath}</div>
                  <div className="text-xs text-muted-foreground">Conflict {conflict.index}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {CHOICE_LABELS.map(({ choice, label, description }) => (
                    <button
                      key={choice}
                      type="button"
                      title={description}
                      onClick={() => onDecisionChange(conflict.id, { ...decision, choice })}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-all ${
                        decision?.choice === choice
                          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                          : 'border-border bg-background hover:bg-muted text-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                <CodeBlock label={`Current / ours (${conflict.oursLabel})`} lines={conflict.ours} selected={decision?.choice === 'ours'} />
                <CodeBlock label={`Incoming / theirs (${conflict.theirsLabel})`} lines={conflict.theirs} selected={decision?.choice === 'theirs'} />
              </div>

              {(decision?.choice === 'both' || decision?.choice === 'manual') && (
                <div className="px-4 pb-4">
                  <textarea
                    value={decision.note ?? ''}
                    onChange={(event) => onDecisionChange(conflict.id, { ...decision, note: event.target.value })}
                    placeholder={decision.choice === 'both' ? 'Optional: explain how to combine both sides...' : 'Describe the manual resolution you want...'}
                    className="w-full min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
