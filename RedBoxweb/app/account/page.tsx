import { SiteHeader } from '../components/SiteHeader';
import { AccountConsole } from './AccountConsole';

export const dynamic = 'force-dynamic';

export default function AccountPage() {
    return (
        <main className="min-h-screen pt-32 text-[#22170f] md:pt-28">
            <SiteHeader compact />
            <AccountConsole />
        </main>
    );
}
