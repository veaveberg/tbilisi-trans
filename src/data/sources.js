// Check if running in Capacitor
const isCapacitor = typeof window !== 'undefined' && window.Capacitor;

// When in Capacitor, we MUST use the full real URL, bypassing all proxies
// When in Browser Dev, we use localhost proxy
// When in Browser Prod, we use PROD_BASE (which might be the worker)
const TBILISI_REAL_API = 'https://transit.ttc.com.ge/pis-gateway/api';
const RUSTAVI_REAL_API = 'https://rustavi-transit.azrycloud.com/pis-gateway/api';

const PROD_BASE = import.meta.env.VITE_API_BASE_URL || (window.location.origin + import.meta.env.BASE_URL);

export const sources = [
    {
        id: 'tbilisi',
        stripPrefixes: ['1:'],
        apiBase: isCapacitor
            ? `${TBILISI_REAL_API}/v2`
            : (import.meta.env.DEV ? '/pis-gateway/api/v2' : `${PROD_BASE}/pis-gateway/api/v2`),
        apiBaseV3: isCapacitor
            ? `${TBILISI_REAL_API}/v3`
            : (import.meta.env.DEV ? '/pis-gateway/api/v3' : `${PROD_BASE}/pis-gateway/api/v3`)
    },
    {
        id: 'rustavi',
        prefix: 'r',
        separator: '',
        stripPrefixes: ['1:', '2:'],
        apiBase: isCapacitor
            ? `${RUSTAVI_REAL_API}/v2`
            : (import.meta.env.DEV ? '/rustavi-proxy/pis-gateway/api/v2' : `${PROD_BASE}/rustavi-proxy/pis-gateway/api/v2`),
        apiBaseV3: isCapacitor
            ? `${RUSTAVI_REAL_API}/v3`
            : (import.meta.env.DEV ? '/rustavi-proxy/pis-gateway/api/v3' : `${PROD_BASE}/rustavi-proxy/pis-gateway/api/v3`)
    }
];
