/** The app mark and wordmark, the link back to all projects. Shared by the workspace top bar and the page header. */
export function BrandMark() {
  return (
    <a className="sh-mark" href="#/" aria-label="Insight, all projects">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <rect width="24" height="24" rx="6.5" fill="var(--accent)" />
        <rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="none" stroke="var(--on-accent)" strokeWidth="1.6" strokeOpacity=".55" />
        <circle cx="12" cy="12" r="2.6" fill="var(--on-accent)" />
      </svg>
      <span className="sh-mark-name">Insight</span>
    </a>
  );
}
