import { Redirect } from 'expo-router';

/**
 * Any unmatched route (e.g. the app is launched by Telegram at `/tma/`, or the
 * URL carries `tgWebApp*` launch/theme params) must NOT show the raw
 * "Unmatched Route" screen inside the Mini App. Silently recover to the home
 * screen — the Telegram WebApp SDK has already parsed initData from the URL by
 * the time this renders.
 */
export default function NotFound() {
  return <Redirect href="/" />;
}
