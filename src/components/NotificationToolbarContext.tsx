import {
  createContext,
  useContext,
  type PropsWithChildren,
} from "react";

export type NotificationToolbarState = {
  unread: number;
  openNotificationDrawer: () => void;
};

const NotificationToolbarContext =
  createContext<NotificationToolbarState | null>(null);

export function NotificationToolbarProvider({
  children,
  value,
}: PropsWithChildren<{ value: NotificationToolbarState }>) {
  return (
    <NotificationToolbarContext.Provider value={value}>
      {children}
    </NotificationToolbarContext.Provider>
  );
}

export function useNotificationToolbar() {
  return useContext(NotificationToolbarContext);
}
