import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWeb } from "../api";

const MAP: [string, string][] = [
  ["n", "North"], ["s", "South"], ["e", "East"], ["w", "West"],
  ["ne", "NorthEast"], ["nw", "NorthWest"], ["se", "SouthEast"], ["sw", "SouthWest"],
];

/** 无边框窗口的边缘拖拽缩放（Windows）。 */
export default function ResizeHandles() {
  /* 网页版没有 Tauri 宿主窗口：getCurrentWindow() 会同步抛 TypeError
     （读 undefined 的 metadata），在渲染期抛错会让整个应用挂不上。
     网页里本来也不需要窗口缩放热区，直接不渲染。 */
  if (isWeb) return null;
  const win = getCurrentWindow();
  return (
    <div className="pointer-events-none absolute inset-0 z-[70]">
      {MAP.map(([edge, dir]) => (
        <div key={edge}
          className={`win-resize win-resize-${edge} pointer-events-auto`}
          onPointerDown={(e) => {
            e.preventDefault();
            // ResizeDirection 在类型包里未导出，按字符串传入
            (win.startResizeDragging as unknown as (d: string) => Promise<void>)(dir).catch(() => {});
          }}
        />
      ))}
    </div>
  );
}