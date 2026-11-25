import { SIDEBAR_MAX, SIDEBAR_MIN, type useSidebar } from '../useSidebar'

/** The draggable, keyboard-operable edge between the sidebar and the page. */
export default function SidebarResizer({ sidebar }: { sidebar: ReturnType<typeof useSidebar> }) {
  if (sidebar.collapsed) return null
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={sidebar.expandedWidth}
      tabIndex={0}
      className="sidebar-resize absolute bottom-0 top-0 z-30 hidden w-1.5 cursor-col-resize touch-none min-[901px]:block"
      style={{ left: sidebar.width - 3 }}
      {...sidebar.resizeHandlers}
    />
  )
}
