import { useEffect, useState } from "react";
import { countryFlag } from "@/lib/country-flag";
import { lookupIpCountryLocal } from "@/lib/ip-country";

export function IpCountryFlag({ ip, country, className = "" }: {
  ip: string | null | undefined;
  country: string | null | undefined;
  className?: string;
}) {
  const [detected, setDetected] = useState<{ ip: string; country: string | null }>({ ip: "", country: null });
  useEffect(() => {
    if (!ip || countryFlag(country)) return;
    let active = true;
    lookupIpCountryLocal(ip).then((value) => {
      if (active) setDetected({ ip, country: value });
    });
    return () => { active = false; };
  }, [ip, country]);

  const code = countryFlag(country) ? country : detected.ip === ip ? detected.country : null;
  const flag = countryFlag(code);
  return flag ? <span className={className} title={`Страна выхода: ${code}`} aria-label={`Страна выхода: ${code}`}>{flag}</span> : null;
}

