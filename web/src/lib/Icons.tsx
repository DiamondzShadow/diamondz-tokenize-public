// Stroke icons (replacing emoji, which render as empty boxes on some phones). Decorative unless `label` is given.
import type { ReactNode } from "react";
import type { AssetClassId } from "./catalog";

function Svg({ children, label, size = 22 }: { children: ReactNode; label?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {children}
    </svg>
  );
}
type P = { label?: string; size?: number };

export const MenuIcon = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const CloseIcon = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const BackIcon = (p: P) => <Svg {...p}><path d="M15 6l-6 6 6 6" /></Svg>;
export const ChevronIcon = (p: P) => <Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>;
export const CheckIcon = (p: P) => <Svg {...p}><path d="M5 12l4 4 10-10" /></Svg>;
export const GridIcon = (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Svg>;
export const IncomeIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5c0-1.1 1.1-2 2.5-2s2.5.9 2.5 2-1.1 1.7-2.5 2-2.5.9-2.5 2 1.1 2 2.5 2 2.5-.9 2.5-2" /></Svg>;
export const WalletIcon = (p: P) => <Svg {...p}><path d="M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zM3 7l12-3v3M16 14h2" /></Svg>;
export const TagIcon = (p: P) => <Svg {...p}><path d="M3 12V4h8l10 10-8 8L3 12z" /><circle cx="7.5" cy="8.5" r="1.5" /></Svg>;
export const BuildingIcon = (p: P) => <Svg {...p}><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6" /></Svg>;
export const DashboardIcon = (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>;
export const PlusIcon = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const CardIcon = (p: P) => <Svg {...p}><path d="M3 6h18v13H3zM3 10h18M7 15h4" /></Svg>;
export const BrushIcon = (p: P) => <Svg {...p}><path d="M14 4l6 6-8 8H6v-6l8-8zM4 20h4" /></Svg>;
export const ReceiptIcon = (p: P) => <Svg {...p}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6" /></Svg>;
export const BookIcon = (p: P) => <Svg {...p}><path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2V5zM4 19a2 2 0 0 1 2-2h14" /></Svg>;
export const StoreIcon = (p: P) => <Svg {...p}><path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6" /></Svg>;
export const LogoutIcon = (p: P) => <Svg {...p}><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></Svg>;
export const UsersIcon = (p: P) => <Svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.8 3.1 2.6 3.5 5.2" /></Svg>;
export const MailIcon = (p: P) => <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" /></Svg>;
export const ArchiveIcon = (p: P) => <Svg {...p}><path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" /></Svg>;
export const MoreIcon = (p: P) => <Svg {...p}><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></Svg>;

const CLASS_PATHS: Record<AssetClassId, ReactNode> = {
  "real-estate": <path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6" />,
  energy: <path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z" />,
  "private-equity": <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />,
  "private-credit": <><path d="M3 10l9-6 9 6M5 10v8M19 10v8M9 10v8M15 10v8M3 20h18" /></>,
  funds: <><path d="M4 8h16l-2 12H6L4 8zM8 8V6a4 4 0 0 1 8 0v2" /></>,
  "music-ip": <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  film: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M7 6l2-3M12 6l2-3M17 6l2-3" /></>,
  sports: <><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4" /></>,
  collectibles: <><path d="M6 3h12l3 6-9 12L3 9l3-6zM3 9h18M12 21L8 9l4-6 4 6-4 12" /></>,
  carbon: <><path d="M5 21c0-9 5-15 15-17-1 10-7 15-15 17zM5 21l8-8" /></>,
};
export const AssetClassIcon = ({ id, ...p }: P & { id: AssetClassId }) => <Svg {...p}>{CLASS_PATHS[id] ?? CLASS_PATHS["real-estate"]}</Svg>;
export const LockIcon = (p: P) => <Svg {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></Svg>;
