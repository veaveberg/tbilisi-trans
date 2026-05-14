import socket
import concurrent.futures

prefixes = ['mtskheta', 'mtskhetatransit', 'mtskheta-transit', 'transit-mtskheta', 'transit.mtskheta', 'mtskheta.transit', 'kutaisi', 'kutaisitransit', 'kutaisi-transit', 'transit-kutaisi', 'transit.kutaisi', 'kutaisi.transit', 'gurjaani', 'gurjaanitransit', 'gurjaani-transit', 'transit-gurjaani', 'transit.gurjaani', 'gurjaani.transit', 'transit', 'pis']
bases = ['azrycloud.com', 'azry.com', 'azry.ge', 'ttc.com.ge']

domains = []
for p in prefixes:
    for b in bases:
        domains.append(f"{p}.{b}")

def check(domain):
    try:
        ip = socket.gethostbyname(domain)
        return f"[+] {domain} -> {ip}"
    except Exception:
        return None

with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
    results = executor.map(check, domains)
    for r in results:
        if r:
            print(r)
