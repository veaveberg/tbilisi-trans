const PROD_BASE = import.meta.env.VITE_API_BASE_URL || (window.location.origin + import.meta.env.BASE_URL);

export const sources = [
    {
        id: 'tbilisi',
        stripPrefix: '1:',
        apiBase: import.meta.env.DEV
            ? '/pis-gateway/api/v2'
            : `${PROD_BASE}/pis-gateway/api/v2`,
        apiBaseV3: import.meta.env.DEV
            ? '/pis-gateway/api/v3'
            : `${PROD_BASE}/pis-gateway/api/v3`
    },
    {
        id: 'rustavi',
        prefix: 'r',
        separator: '',
        stripPrefix: '1:',
        apiBase: import.meta.env.DEV
            ? '/rustavi-proxy/pis-gateway/api/v2'
            : `${PROD_BASE}/rustavi-proxy/pis-gateway/api/v2`,
        apiBaseV3: import.meta.env.DEV
            ? '/rustavi-proxy/pis-gateway/api/v3'
            : `${PROD_BASE}/rustavi-proxy/pis-gateway/api/v3`
    }
];
