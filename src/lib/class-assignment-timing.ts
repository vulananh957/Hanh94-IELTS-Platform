type Distribution = 'all' | 'specific';

type ClassAssignment = {
  distribution: Distribution;
  selectedClasses: string[];
  openedAtByClass: Record<string, unknown>;
  allOpenedAt: unknown | null;
  updatedAt: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function selectedClasses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
}

function distribution(value: unknown, selected: string[]): Distribution {
  return value === 'specific' || selected.length > 0 ? 'specific' : 'all';
}

export function buildClassAssignmentWithOpenedTimes(
  current: unknown,
  next: { distribution: Distribution; selectedClasses: string[] },
  openedAt: Date,
): ClassAssignment {
  const previous = asRecord(current);
  const previousSelected = selectedClasses(previous.selectedClasses);
  const previousDistribution = distribution(previous.distribution, previousSelected);
  const previousTimes = asRecord(previous.openedAtByClass);
  const nextSelected = next.distribution === 'specific' ? selectedClasses(next.selectedClasses) : [];

  if (next.distribution === 'all') {
    const previousAllTime = previous.allOpenedAt ?? previous.updatedAt;
    return {
      distribution: 'all',
      selectedClasses: [],
      openedAtByClass: {},
      allOpenedAt: previousDistribution === 'all' && previousAllTime ? previousAllTime : openedAt,
      updatedAt: openedAt,
    };
  }

  const openedAtByClass: Record<string, unknown> = {};
  nextSelected.forEach((classId) => {
    const unchanged = previousDistribution === 'specific' && previousSelected.includes(classId);
    const legacyOpenedAt = previousDistribution === 'all'
      ? previous.allOpenedAt ?? previous.updatedAt
      : previous.updatedAt;
    openedAtByClass[classId] = unchanged
      ? previousTimes[classId] ?? legacyOpenedAt ?? openedAt
      : openedAt;
  });

  return {
    distribution: 'specific',
    selectedClasses: nextSelected,
    openedAtByClass,
    allOpenedAt: null,
    updatedAt: openedAt,
  };
}

export function getClassAssignmentOpenedAt(
  classAssignment: unknown,
  classKeys: string[],
  fallback: unknown,
): unknown {
  const assignment = asRecord(classAssignment);
  const selected = selectedClasses(assignment.selectedClasses);
  const assignmentDistribution = distribution(assignment.distribution, selected);

  if (assignmentDistribution === 'all') {
    return assignment.allOpenedAt ?? assignment.updatedAt ?? fallback;
  }

  const openedAtByClass = asRecord(assignment.openedAtByClass);
  for (const classKey of classKeys) {
    if (openedAtByClass[classKey]) return openedAtByClass[classKey];
  }

  return assignment.updatedAt ?? fallback;
}
