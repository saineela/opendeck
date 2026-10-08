import { useEffect } from "react";

export function useDisableContextMenu() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
    };

    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);
}

