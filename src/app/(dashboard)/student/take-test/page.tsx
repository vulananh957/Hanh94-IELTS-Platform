import { Suspense } from 'react';
import { TakeTestContent } from './take-test-content';

export default function StudentTakeTestPage() {
  return (
    <Suspense fallback={<div className="tt-loading">Loading test...</div>}>
      <TakeTestContent />
    </Suspense>
  );
}
