'use client';

import { useCallback, useEffect, useState } from 'react';

export type TopUpFormProps = {
  minTopUpRubles: number;
  rublesPerCredit: number;
  paymentsEnabled: boolean;
};

type PaymentStatus = 'created' | 'pending' | 'succeeded' | 'canceled' | 'failed';

type StatusResponse = {
  ok: true;
  paymentId: string;
  status: PaymentStatus;
  amountKopecks: number;
  credits: number;
  creditedAt: string | null;
};

const STATUS_LABELS: Record<PaymentStatus, string> = {
  created: 'создан',
  pending: 'ожидает оплаты',
  succeeded: 'оплачен, кредиты зачислены',
  canceled: 'отменён',
  failed: 'не выполнен',
};

function formatRublesFromKopecks(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;
}

export default function TopUpForm({
  minTopUpRubles,
  rublesPerCredit,
  paymentsEnabled,
}: TopUpFormProps) {
  const [amount, setAmount] = useState(String(minTopUpRubles));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<StatusResponse | null>(null);
  const [checking, setChecking] = useState(false);

  const parsed = Number(amount);
  const validAmount = Number.isInteger(parsed) && parsed >= minTopUpRubles;
  const credits = validAmount ? Math.floor(parsed / rublesPerCredit) : 0;

  const loadStatus = useCallback(async (paymentId: string) => {
    setChecking(true);
    try {
      const res = await fetch(`/api/payments/${encodeURIComponent(paymentId)}`, {
        method: 'GET',
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Не удалось получить статус платежа.');
        return;
      }
      setPayment(data as StatusResponse);
    } catch {
      setError('Сбой связи с сервером.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const paymentId = new URLSearchParams(window.location.search).get('paymentId');
    if (paymentId) {
      void loadStatus(paymentId);
    }
  }, [loadStatus]);

  useEffect(() => {
    if (!payment) return;
    if (payment.status !== 'pending' && payment.status !== 'created') return;

    let cancelled = false;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (cancelled || attempts > 10) {
        window.clearInterval(timer);
        return;
      }
      void loadStatus(payment.paymentId);
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [payment, loadStatus]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validAmount || busy) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parsed,
          operationId:
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Не удалось создать платёж.');
        return;
      }

      if (typeof data?.confirmationUrl === 'string' && data.confirmationUrl.length > 0) {
        window.location.assign(data.confirmationUrl);
        return;
      }

      if (typeof data?.paymentId === 'string') {
        await loadStatus(data.paymentId);
      }
    } catch {
      setError('Сбой связи с сервером.');
    } finally {
      setBusy(false);
    }
  }

  if (!paymentsEnabled) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-xl px-6 py-5">
        <h2 className="text-xs font-mono tracking-wider text-slate-400 uppercase mb-3">
          Пополнение баланса
        </h2>
        <p className="text-sm text-slate-400 leading-relaxed">
          Приём платежей пока не подключён. Пополнение станет доступно после публикации условий
          оплаты.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-xl px-6 py-5">
      <h2 className="text-xs font-mono tracking-wider text-slate-400 uppercase mb-3">
        Пополнение баланса
      </h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="text-xs text-slate-400">Сумма пополнения, ₽</span>
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min={minTopUpRubles}
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setError(null);
            }}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
            disabled={busy}
          />
        </label>

        <p className="text-xs text-slate-400">
          Минимум {minTopUpRubles.toLocaleString('ru-RU')} ₽. Вы получите{' '}
          <span className="text-cyan-400 font-mono">{credits.toLocaleString('ru-RU')}</span>{' '}
          кредит(ов) (1 ₽ = {rublesPerCredit} кредит).
        </p>

        {!validAmount && amount.length > 0 && (
          <p className="text-xs text-amber-400">
            Введите целое число не меньше {minTopUpRubles.toLocaleString('ru-RU')} ₽.
          </p>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={!validAmount || busy}
          className="w-full px-6 py-3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm transition-all shadow-lg shadow-cyan-500/20"
        >
          {busy ? 'Создаём платёж…' : 'Перейти к оплате'}
        </button>
      </form>

      {payment && (
        <div className="mt-4 border-t border-slate-800/80 pt-4 space-y-1">
          <p className="text-xs text-slate-400">
            Платёж на {formatRublesFromKopecks(payment.amountKopecks)} —{' '}
            <span className="text-slate-200">{STATUS_LABELS[payment.status] ?? payment.status}</span>
          </p>
          {payment.status === 'succeeded' ? (
            <p className="text-xs text-green-400">
              Зачислено {payment.credits.toLocaleString('ru-RU')} кредит(ов). Обновите страницу,
              чтобы увидеть новый баланс.
            </p>
          ) : payment.status === 'canceled' || payment.status === 'failed' ? (
            <p className="text-xs text-amber-400">
              Кредиты не зачислены. Вы можете создать новое пополнение.
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              {checking ? 'Проверяем статус…' : 'Статус обновляется автоматически.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
