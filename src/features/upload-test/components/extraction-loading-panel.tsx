export function ExtractionLoadingPanel() {
  return (
    <div className="workbench-loading-panel">
      <div className="workbench-loading-head">
        <div className="workbench-loading-dot" />
        <p className="workbench-loading-title">Gemini is extracting structured IELTS data...</p>
      </div>

      <div className="workbench-loading-grid">
        <div className="workbench-loading-col">
          <div className="workbench-loading-line workbench-loading-line-short" />
          <div className="workbench-loading-box workbench-loading-box-tall" />
        </div>

        <div className="workbench-loading-col">
          <div className="workbench-loading-line workbench-loading-line-medium" />
          <div className="workbench-loading-stack">
            <div className="workbench-loading-box workbench-loading-box-row" />
            <div className="workbench-loading-box workbench-loading-box-row" />
            <div className="workbench-loading-box workbench-loading-box-row" />
            <div className="workbench-loading-box workbench-loading-box-large" />
          </div>
        </div>
      </div>
    </div>
  );
}
