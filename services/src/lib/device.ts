/** Phone, tablet or computer, from the user agent. We keep only this, never the IP address. */
export function deviceOf(userAgent: string | undefined): 'phone' | 'tablet' | 'computer' {
  const ua = userAgent ?? '';
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'phone';
  return 'computer';
}
