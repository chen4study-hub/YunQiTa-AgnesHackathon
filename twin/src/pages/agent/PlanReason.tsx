import { useRef } from "react";

/** Preview whole sentences only; retain every byte of the full reason in the dialog. */
export function reasonPreview(reason: string): string {
  const sentences = reason.match(/[^。！？]+[。！？]|[^。！？]+$/g) ?? [reason];
  const first = sentences[0] ?? reason;
  return first.length < 75 && sentences.length > 1
    ? first + sentences[1]
    : first;
}
export function PlanReason({ reason }: { reason: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <div className="agent-plan-reason">
      <p className="agent-reason-preview">
        {(
          reasonPreview(reason).match(/[^。！？]+[。！？]|[^。！？]+$/g) ?? [
            reason,
          ]
        ).map((sentence, i) => (
          <span className="agent-reason-sentence" key={i}>
            {sentence}
          </span>
        ))}
      </p>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        展开调度理由
      </button>
      <dialog
        ref={dialog}
        className="agent-reason-dialog"
        aria-label="完整调度理由"
      >
        <header>
          <h3>完整调度理由</h3>
          <button type="button" onClick={() => dialog.current?.close()}>
            关闭
          </button>
        </header>
        <div className="agent-reason-full" tabIndex={0}>
          <p>{reason}</p>
        </div>
      </dialog>
    </div>
  );
}
