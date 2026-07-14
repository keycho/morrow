// interior footer. the disclaimer rides on every page per the comms rules.

import { DISCLAIMER } from "@/lib/constants";

export function SiteFooter() {
  return <footer className="site-footer">{DISCLAIMER}</footer>;
}
