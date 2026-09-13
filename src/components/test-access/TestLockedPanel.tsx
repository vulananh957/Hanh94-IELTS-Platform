export function TestLockedPanel({ onBack }: { onBack: () => void }) {
  return (
    <main className="tt-locked-page">
      <section className="tt-locked-card" role="alert" aria-live="assertive">
        <div className="tt-locked-icon"><i className="fas fa-lock" /></div>
        <h1>Test Locked</h1>
        <p>This test has been locked because you stopped screen sharing. Please ask your teacher to unlock it before you can retake the test.</p>
        <p className="tt-locked-note">Once unlocked, you will need to restart the test from the beginning.</p>
        <button type="button" className="tt-primary" onClick={onBack}>Back to Assignments</button>
      </section>
    </main>
  );
}
