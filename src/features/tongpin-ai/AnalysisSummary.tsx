/** Model-authored public explanation. A native details element keeps the
 * answer compact and collapsed by default without pretending to stream work. */
export function AnalysisSummary({ children }: { children: string }) {
  return <details className="tp-ai-analysis-summary">
    <summary>分析摘要</summary>
    <p>{children}</p>
  </details>;
}
