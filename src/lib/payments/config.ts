export type PaymentsConfig = {
  enabled: boolean;
  shopId: string | null;
  secretKey: string | null;
  apiBaseUrl: string;
  returnUrl: string | null;
};

export const YOOKASSA_API_BASE = 'https://api.yookassa.ru/v3';

export function readPaymentsConfig(env: NodeJS.ProcessEnv = process.env): PaymentsConfig {
  const rawEnabled = (env.PAYMENTS_ENABLED ?? '').trim().toLowerCase();
  const shopId = (env.YOOKASSA_SHOP_ID ?? '').trim();
  const secretKey = (env.YOOKASSA_SECRET_KEY ?? '').trim();
  const returnUrl = (env.PAYMENTS_RETURN_URL ?? '').trim();

  return {
    enabled: rawEnabled === 'true' && shopId.length > 0 && secretKey.length > 0,
    shopId: shopId.length > 0 ? shopId : null,
    secretKey: secretKey.length > 0 ? secretKey : null,
    apiBaseUrl: (env.YOOKASSA_API_BASE_URL ?? '').trim() || YOOKASSA_API_BASE,
    returnUrl: returnUrl.length > 0 ? returnUrl : null,
  };
}

export function isPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readPaymentsConfig(env).enabled;
}
