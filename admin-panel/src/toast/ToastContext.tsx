/**
 * Toasts de feedback (G3): confirmación visible de acciones (aprobar/rechazar) y errores.
 * Sin librerías: contexto + lista con auto-dismiss.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export interface Toast {
  id: number;
  type: 'success' | 'error';
  message: string;
}

interface ToastApi {
  showToast: (type: Toast['type'], message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const showToast = useCallback((type: Toast['type'], message: string) => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { id, type, message }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === 'success' ? '✅' : '⚠️'} {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast fuera de ToastProvider');
  return ctx;
}
