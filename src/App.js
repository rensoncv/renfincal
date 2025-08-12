import React from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, addDoc, query, getDocs, deleteDoc, where, writeBatch } from 'firebase/firestore';
// Recharts is a charting library that will be used for the analysis page.
// We are assuming it is available in the environment.
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';


// --- Firebase Configuration ---
// This configuration is automatically populated by the environment.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// --- App ID ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'renfincal-app';

// --- Firebase Initialization ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- Helper function outside component to avoid recreation on render ---
const getCutoffDate = (months) => {
    const date = new Date();
    date.setMonth(date.getMonth() - months);
    return date;
};


// --- Main App Component ---
export default function App() {
    const [page, setPage] = React.useState('dashboard');
    const [user, setUser] = React.useState(null);
    const [isAuthReady, setIsAuthReady] = React.useState(false);
    const [transactions, setTransactions] = React.useState([]);
    const [budgets, setBudgets] = React.useState({});
    const [incomes, setIncomes] = React.useState([]);
    const [liabilities, setLiabilities] = React.useState([]);
    const [assets, setAssets] = React.useState([]);
    const [categories, setCategories] = React.useState(['Rent/Mortgage', 'Utilities', 'Grocery', 'Shopping', 'Transport', 'Family support', 'Charity', 'H&L Insurance', 'Entertainment', 'Other']);
    const [recurring, setRecurring] = React.useState([]);
    const [selectedDate, setSelectedDate] = React.useState(new Date());
    const [currencyRates, setCurrencyRates] = React.useState({ EUR: 1, INR: 90 });

    // --- Script Loader for PapaParse ---
    React.useEffect(() => {
        const script = document.createElement('script');
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.3.2/papaparse.min.js";
        script.async = true;
        document.body.appendChild(script);
        return () => {
            document.body.removeChild(script);
        };
    }, []);

    // --- Authentication ---
    // This effect handles user authentication state changes.
    React.useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser) {
                setUser(currentUser);
            } else {
                try {
                    // Sign in with a custom token if available, otherwise sign in anonymously.
                    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                        await signInWithCustomToken(auth, __initial_auth_token);
                    } else {
                        await signInAnonymously(auth);
                    }
                } catch (error) { console.error("Authentication Error:", error); }
            }
            setIsAuthReady(true);
        });
        return () => unsubscribe();
    }, []);

    // --- Data Fetching & Recurring Transactions Processing ---
    // This effect fetches all necessary data from Firestore once the user is authenticated.
    React.useEffect(() => {
        if (!isAuthReady || !user) return;
        const userId = user.uid;

        // Processes recurring transactions to see if any new entries need to be created.
        const processRecurringTransactions = async (recurringItems) => {
            const batch = writeBatch(db);
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            for (const item of recurringItems) {
                let lastProcessed = item.lastProcessed ? new Date(item.lastProcessed) : new Date(item.startDate);
                let nextDueDate = new Date(lastProcessed);

                while (nextDueDate < today) {
                    if (item.frequency === 'monthly') {
                        nextDueDate.setMonth(nextDueDate.getMonth() + 1);
                    } else if (item.frequency === 'yearly') {
                        nextDueDate.setFullYear(nextDueDate.getFullYear() + 1);
                    }

                    if (nextDueDate < today) {
                        const collectionName = item.type === 'income' ? 'incomes' : 'transactions';
                        const newEntry = { ...item.details, date: nextDueDate.toISOString().split('T')[0] };
                        const newDocRef = doc(collection(db, `artifacts/${appId}/users/${userId}/${collectionName}`));
                        batch.set(newDocRef, newEntry);
                        
                        const recurringDocRef = doc(db, `artifacts/${appId}/users/${userId}/recurring`, item.id);
                        batch.update(recurringDocRef, { lastProcessed: nextDueDate.toISOString().split('T')[0] });
                    }
                }
            }
            await batch.commit();
        };

        // Set up real-time listeners for all data collections.
        const unsubscribers = [
            onSnapshot(query(collection(db, `artifacts/${appId}/users/${userId}/transactions`)), (snapshot) => setTransactions(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })))),
            onSnapshot(query(collection(db, `artifacts/${appId}/users/${userId}/incomes`)), (snapshot) => setIncomes(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })))),
            onSnapshot(query(collection(db, `artifacts/${appId}/users/${userId}/liabilities`)), (snapshot) => setLiabilities(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })))),
            onSnapshot(query(collection(db, `artifacts/${appId}/users/${userId}/assets`)), (snapshot) => setAssets(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })))),
            onSnapshot(doc(db, `artifacts/${appId}/users/${userId}/categories`, 'userCategories'), (doc) => { if (doc.exists()) setCategories(doc.data().list); }),
            onSnapshot(query(collection(db, `artifacts/${appId}/users/${userId}/recurring`)), (snapshot) => {
                const recurringData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setRecurring(recurringData);
                processRecurringTransactions(recurringData);
            }),
        ];

        const budgetId = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}`;
        unsubscribers.push(onSnapshot(doc(db, `artifacts/${appId}/users/${userId}/budgets`, budgetId), (doc) => setBudgets(doc.exists() ? doc.data() : {})));
        
        // Fetch latest currency exchange rates.
        fetch('https://api.exchangerate-api.com/v4/latest/EUR')
            .then(res => res.json())
            .then(data => { if (data.rates && data.rates.INR) setCurrencyRates({ EUR: 1, INR: data.rates.INR }); })
            .catch(err => console.error("Could not fetch currency rates, using fallback.", err));

        // Clean up listeners on component unmount.
        return () => unsubscribers.forEach(unsub => unsub());
    }, [isAuthReady, user, selectedDate]);
    
    // Memoize page setter to prevent re-renders in Header
    const memoizedSetPage = React.useCallback(page => setPage(page), []);


    // --- Render Logic ---
    // Show a loading screen while authentication is in progress.
    if (!isAuthReady || !user) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
                <h2 className="text-2xl font-semibold">Authenticating...</h2>
                <p className="mt-2 text-gray-400">Please wait while we securely log you in.</p>
            </div>
        );
    }

    // Renders the component corresponding to the current page state.
    const renderPage = () => {
        switch (page) {
            case 'dashboard': return <Dashboard transactions={transactions} budgets={budgets} incomes={incomes} liabilities={liabilities} assets={assets} selectedDate={selectedDate} setSelectedDate={setSelectedDate} currencyRates={currencyRates} />;
            case 'entry': return <EntryPage user={user} liabilities={liabilities} categories={categories} />;
            case 'budget': return <BudgetPage user={user} budgets={budgets} selectedDate={selectedDate} categories={categories} setCategories={setCategories} />;
            case 'analysis': return <AnalysisPage user={user} transactions={transactions} incomes={incomes} currencyRates={currencyRates} categories={categories} />;
            case 'recurring': return <RecurringPage user={user} recurring={recurring} categories={categories} />;
            case 'history': return <HistoryPage user={user} transactions={transactions} incomes={incomes} />;
            default: return <Dashboard transactions={transactions} budgets={budgets} incomes={incomes} liabilities={liabilities} assets={assets} selectedDate={selectedDate} setSelectedDate={setSelectedDate} currencyRates={currencyRates} />;
        }
    };

    return (
        <div className="bg-gray-900 text-white min-h-screen font-sans"><div className="container mx-auto p-4 md:p-8"><Header setPage={memoizedSetPage} user={user} /><main>{renderPage()}</main></div></div>
    );
}

// --- Header Component (Memoized) ---
const Header = React.memo(function Header({ setPage, user }) {
    return (
        <header className="mb-8">
            <div className="flex flex-wrap justify-between items-center">
                <h1 className="text-3xl md:text-4xl font-bold text-cyan-400 mb-4 md:mb-0">Renfincal</h1>
                <nav className="flex flex-wrap items-center space-x-2 md:space-x-4">
                    <button onClick={() => setPage('dashboard')} className="px-3 py-2 text-sm md:text-base rounded-md hover:bg-gray-700 transition">Dashboard</button>
                    <button onClick={() => setPage('entry')} className="px-3 py-2 text-sm md:text-base rounded-md hover:bg-gray-700 transition">Add Entry</button>
                    <button onClick={() => setPage('history')} className="px-3 py-2 text-sm md:text-base rounded-md hover:bg-gray-700 transition">History</button>
                    <button onClick={() => setPage('budget')} className="px-3 py-2 text-sm md:text-base rounded-md hover:bg-gray-700 transition">Budget</button>
                    <button onClick={() => setPage('recurring')} className="px-3 py-2 text-sm md:text-base rounded-md hover:bg-gray-700 transition">Recurring</button>
                    <button onClick={() => setPage('analysis')} className="px-3 py-2 text-sm md:text-base rounded-md hover:bg-gray-700 transition">Analysis</button>
                </nav>
            </div>
            {user && <p className="text-xs text-gray-500 mt-2">User ID: {user.uid}</p>}
        </header>
    );
});

// --- Dashboard Component (Memoized with useMemo for calculations) ---
const Dashboard = React.memo(function Dashboard({ transactions, budgets, incomes, liabilities, assets, selectedDate, setSelectedDate, currencyRates }) {
    const selectedMonth = selectedDate.getMonth();
    const selectedYear = selectedDate.getFullYear();
    
    const handlePreviousMonth = React.useCallback(() => setSelectedDate(new Date(selectedYear, selectedMonth - 1, 1)), [selectedYear, selectedMonth, setSelectedDate]);
    const handleNextMonth = React.useCallback(() => setSelectedDate(new Date(selectedYear, selectedMonth + 1, 1)), [selectedYear, selectedMonth, setSelectedDate]);

    // Memoize expensive calculations
    const { eurBalances, inrBalances } = React.useMemo(() => {
        const startOfSelectedMonth = new Date(selectedYear, selectedMonth, 1);
        const calculateBalances = (currency) => {
            const filterByCurrency = (item) => item.currency === currency;
            const filterByDate = (item) => new Date(item.date) < startOfSelectedMonth;
            const filterByMonth = (item) => new Date(item.date).getMonth() === selectedMonth && new Date(item.date).getFullYear() === selectedYear;
            const sumAmount = (items) => items.reduce((sum, t) => sum + t.amount, 0);

            const prevIncomes = sumAmount(incomes.filter(filterByCurrency).filter(filterByDate));
            const prevTransactions = transactions.filter(filterByCurrency).filter(filterByDate);
            const opening = prevIncomes - sumAmount(prevTransactions.filter(t => ['expense', 'savings', 'liabilityPayment'].includes(t.type))) + sumAmount(prevTransactions.filter(t => t.type === 'savingsWithdrawal'));

            const monthlyIncomesTotal = sumAmount(incomes.filter(filterByCurrency).filter(filterByMonth));
            const monthlyTransactionsFiltered = transactions.filter(filterByCurrency).filter(filterByMonth);
            const cashFlow = monthlyIncomesTotal - sumAmount(monthlyTransactionsFiltered.filter(t => ['expense', 'savings', 'liabilityPayment'].includes(t.type))) + sumAmount(monthlyTransactionsFiltered.filter(t => t.type === 'savingsWithdrawal'));
            
            return { opening, cashFlow, closing: opening + cashFlow };
        };
        return { eurBalances: calculateBalances('EUR'), inrBalances: calculateBalances('INR') };
    }, [transactions, incomes, selectedMonth, selectedYear]);

    const formatBalance = React.useCallback((eur, inr) => {
        const parts = [];
        if (eur !== 0) parts.push(`€${eur.toFixed(2)}`);
        if (inr !== 0) parts.push(`₹${inr.toFixed(2)}`);
        return parts.length > 0 ? parts.join(' + ') : '€0.00';
    }, []);

    const { husbandSavings, wifeSavings } = React.useMemo(() => {
        const calculateDetailedSavings = (person) => {
            const personTransactions = transactions.filter(t => t.saver === person);
            const calculateByCurrency = (currency) => {
                const deposits = personTransactions.filter(t => (t.type === 'savings' || t.type === 'openingBalance') && t.currency === currency).reduce((sum, t) => sum + t.amount, 0);
                const withdrawals = personTransactions.filter(t => t.type === 'savingsWithdrawal' && t.currency === currency).reduce((sum, t) => sum + t.amount, 0);
                return deposits - withdrawals;
            };
            return { eur: calculateByCurrency('EUR'), inr: calculateByCurrency('INR') };
        };
        return { husbandSavings: calculateDetailedSavings('Husband'), wifeSavings: calculateDetailedSavings('Wife') };
    }, [transactions]);

    const liabilityDetails = React.useMemo(() => liabilities.map(liability => {
        const payments = transactions.filter(t => t.type === 'liabilityPayment' && t.liabilityId === liability.id).reduce((sum, t) => sum + t.amount, 0);
        const balance = liability.totalAmount - payments;
        return { ...liability, paid: payments, balance };
    }), [liabilities, transactions]);
    
    const { netWorthEUR, netWorthINR } = React.useMemo(() => {
        const totalAssetsEUR = assets.filter(a => a.currency === 'EUR').reduce((sum, a) => sum + a.value, 0);
        const totalAssetsINR = assets.filter(a => a.currency === 'INR').reduce((sum, a) => sum + a.value, 0);
        const totalSavingsEUR = husbandSavings.eur + wifeSavings.eur;
        const totalSavingsINR = husbandSavings.inr + wifeSavings.inr;
        const totalLiabilitiesEUR = liabilityDetails.filter(l => l.currency === 'EUR').reduce((sum, l) => sum + l.balance, 0);
        const totalLiabilitiesINR = liabilityDetails.filter(l => l.currency === 'INR').reduce((sum, l) => sum + l.balance, 0);
        return {
            netWorthEUR: totalAssetsEUR + totalSavingsEUR - totalLiabilitiesEUR,
            netWorthINR: totalAssetsINR + totalSavingsINR - totalLiabilitiesINR
        };
    }, [assets, husbandSavings, wifeSavings, liabilityDetails]);

    const { expensesByCategory, allCategoryNames } = React.useMemo(() => {
        const toEUR = (amount, currency) => currency === 'INR' ? amount / currencyRates.INR : amount;
        const monthlyTransactions = transactions.filter(t => new Date(t.date).getMonth() === selectedMonth && new Date(t.date).getFullYear() === selectedYear);
        const expensesByCategory = monthlyTransactions.filter(t => t.type === 'expense').reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + toEUR(t.amount, t.currency); return acc; }, {});
        const allCategoryNames = [...new Set([...Object.keys(budgets), ...Object.keys(expensesByCategory)])];
        return { expensesByCategory, allCategoryNames };
    }, [transactions, budgets, selectedMonth, selectedYear, currencyRates]);

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-3 bg-gray-800 p-4 rounded-lg shadow-lg flex justify-between items-center">
                <button onClick={handlePreviousMonth} className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-2 px-4 rounded-md transition">‹ Prev</button>
                <h2 className="text-xl font-semibold text-white">{selectedDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</h2>
                <button onClick={handleNextMonth} className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-2 px-4 rounded-md transition">Next ›</button>
            </div>

            <div className="md:col-span-3 bg-gray-800 p-6 rounded-lg shadow-lg text-center">
                <h2 className="text-2xl font-semibold text-cyan-400 mb-2">Family Net Worth</h2>
                <p className="text-4xl font-bold">{formatBalance(netWorthEUR, netWorthINR)}</p>
            </div>

            <div className="bg-gray-800 p-6 rounded-lg shadow-lg"><h2 className="text-xl font-semibold text-cyan-400 mb-2">Opening Balance</h2><p className="text-2xl font-bold">{formatBalance(eurBalances.opening, inrBalances.opening)}</p></div>
            <div className="bg-gray-800 p-6 rounded-lg shadow-lg"><h2 className="text-xl font-semibold text-cyan-400 mb-2">Current Account Flow</h2><p className="text-2xl font-bold">{formatBalance(eurBalances.cashFlow, inrBalances.cashFlow)}</p></div>
            <div className="bg-gray-800 p-6 rounded-lg shadow-lg"><h2 className="text-xl font-semibold text-cyan-400 mb-2">Closing Balance</h2><p className="text-2xl font-bold">{formatBalance(eurBalances.closing, inrBalances.closing)}</p></div>

            <div className="md:col-span-3 bg-gray-800 p-6 rounded-lg shadow-lg"><h2 className="text-xl font-semibold text-cyan-400 mb-4">Savings Breakdown</h2><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div className="bg-gray-700 p-4 rounded-lg"><h3 className="text-lg font-bold text-blue-400">Husband's Savings</h3><p className="text-md font-semibold mt-2">EUR: €{husbandSavings.eur.toFixed(2)}</p><p className="text-md font-semibold">INR: ₹{husbandSavings.inr.toFixed(2)}</p></div><div className="bg-gray-700 p-4 rounded-lg"><h3 className="text-lg font-bold text-pink-400">Wife's Savings</h3><p className="text-md font-semibold mt-2">EUR: €{wifeSavings.eur.toFixed(2)}</p><p className="text-md font-semibold">INR: ₹{wifeSavings.inr.toFixed(2)}</p></div></div></div>
            <div className="md:col-span-3 bg-gray-800 p-6 rounded-lg shadow-lg"><h2 className="text-xl font-semibold text-cyan-400 mb-4">Liabilities Breakdown</h2><div className="space-y-4">{liabilityDetails.length > 0 ? liabilityDetails.map(l => (<div key={l.id} className="bg-gray-700 p-4 rounded-lg"><h3 className="text-lg font-bold capitalize text-white">{l.name}</h3><div className="grid grid-cols-3 gap-4 mt-2 text-center"><div><p className="text-sm text-gray-400">Total</p><p className="text-md font-semibold">{l.currency === 'EUR' ? '€' : '₹'}{l.totalAmount.toFixed(2)}</p></div><div><p className="text-sm text-gray-400">Paid</p><p className="text-md font-semibold text-green-400">{l.currency === 'EUR' ? '€' : '₹'}{l.paid.toFixed(2)}</p></div><div><p className="text-sm text-gray-400">Balance</p><p className="text-md font-semibold text-red-400">{l.currency === 'EUR' ? '€' : '₹'}{l.balance.toFixed(2)}</p></div></div></div>)) : <p className="text-gray-400">No liabilities added yet.</p>}</div></div>
            <div className="bg-gray-800 p-6 rounded-lg shadow-lg md:col-span-3"><h2 className="text-xl font-semibold text-cyan-400 mb-4">Monthly Expenses vs Budget (in EUR)</h2><div className="space-y-4">{allCategoryNames.map(category => { const budget = budgets[category] || 0; const actual = expensesByCategory[category] || 0; const percentage = budget > 0 ? (actual / budget) * 100 : 0; const isOverBudget = actual > budget; return (<div key={category}><div className="flex justify-between mb-1"><span className="font-medium capitalize">{category}</span><span className={`font-semibold ${isOverBudget && budget > 0 ? 'text-red-500' : 'text-green-400'}`}>€{actual.toFixed(2)} {budget > 0 && `/ €${budget.toFixed(2)}`}</span></div><div className="w-full bg-gray-700 rounded-full h-4"><div className={`h-4 rounded-full ${isOverBudget && budget > 0 ? 'bg-red-500' : 'bg-cyan-500'}`} style={{ width: budget > 0 ? `${Math.min(percentage, 100)}%` : '0%' }}></div></div>{isOverBudget && budget > 0 && <p className="text-red-500 text-sm mt-1">Over budget!</p>}</div>); })}</div></div>
        </div>
    );
});

// --- Entry Page Component (Memoized) ---
const EntryPage = React.memo(function EntryPage({ user, liabilities, categories }) {
    const [entryType, setEntryType] = React.useState('expense');
    const [isOpeningBalance, setIsOpeningBalance] = React.useState(false);
    const [amount, setAmount] = React.useState('');
    const [currency, setCurrency] = React.useState('EUR');
    const [category, setCategory] = React.useState(categories[0]);
    const [payer, setPayer] = React.useState('Husband');
    const [saver, setSaver] = React.useState('Husband');
    const [description, setDescription] = React.useState('');
    const [date, setDate] = React.useState(new Date().toISOString().split('T')[0]);
    const [source, setSource] = React.useState('Husband');
    const [liabilityName, setLiabilityName] = React.useState('');
    const [liabilityId, setLiabilityId] = React.useState('');
    const [assetName, setAssetName] = React.useState('');

    const handleSubmit = React.useCallback(async (e) => {
        e.preventDefault();
        if (!user || (!amount && entryType !== 'asset')) return;

        const userId = user.uid;
        let collectionName;
        let docData = { date, description };

        switch (entryType) {
            case 'expense': collectionName = 'transactions'; Object.assign(docData, { type: 'expense', category, payer, amount: parseFloat(amount), currency }); break;
            case 'savings': collectionName = 'transactions'; Object.assign(docData, { type: isOpeningBalance ? 'openingBalance' : 'savings', saver, amount: parseFloat(amount), currency }); break;
            case 'savingsWithdrawal': collectionName = 'transactions'; Object.assign(docData, { type: 'savingsWithdrawal', saver, amount: parseFloat(amount), currency }); break;
            case 'income': collectionName = 'incomes'; Object.assign(docData, { source, type: 'income', amount: parseFloat(amount), currency }); break;
            case 'addLiability': collectionName = 'liabilities'; Object.assign(docData, { name: liabilityName, totalAmount: parseFloat(amount), currency }); break;
            case 'payLiability': collectionName = 'transactions'; if (!liabilityId) return; Object.assign(docData, { type: 'liabilityPayment', liabilityId, payer, amount: parseFloat(amount), currency }); break;
            case 'asset': collectionName = 'assets'; Object.assign(docData, { name: assetName, value: parseFloat(amount), currency }); break;
            default: return;
        }

        try {
            await addDoc(collection(db, `artifacts/${appId}/users/${userId}/${collectionName}`), docData);
            setAmount(''); setDescription(''); setLiabilityName(''); setAssetName(''); setIsOpeningBalance(false);
        } catch (error) { console.error("Error adding document: ", error); }
    }, [user, amount, entryType, date, description, category, payer, currency, isOpeningBalance, saver, source, liabilityName, liabilityId, assetName]);

    return (
        <div className="max-w-xl mx-auto bg-gray-800 p-8 rounded-lg shadow-lg">
            <div className="flex flex-wrap justify-center mb-6 border-b border-gray-700">
                 <button onClick={() => setEntryType('expense')} className={`px-2 py-2 text-sm font-semibold transition ${entryType === 'expense' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>Expense</button>
                 <button onClick={() => setEntryType('savings')} className={`px-2 py-2 text-sm font-semibold transition ${entryType === 'savings' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>Savings</button>
                 <button onClick={() => setEntryType('savingsWithdrawal')} className={`px-2 py-2 text-sm font-semibold transition ${entryType === 'savingsWithdrawal' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>Withdrawal</button>
                 <button onClick={() => setEntryType('income')} className={`px-2 py-2 text-sm font-semibold transition ${entryType === 'income' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>Income</button>
                 <button onClick={() => setEntryType('asset')} className={`px-2 py-2 text-sm font-semibold transition ${entryType === 'asset' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>Asset</button>
                 <button onClick={() => setEntryType('addLiability')} className={`px-2 py-2 text-sm font-semibold transition ${entryType === 'addLiability' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>Add Liability</button>
                 <button onClick={() => setEntryType('payLiability')} className={`px-2 py-2 text-sm font-semibold transition ${entryType === 'payLiability' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>Pay Liability</button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-6">
                <p className="text-lg font-semibold text-white capitalize">{entryType.replace(/([A-Z])/g, ' $1')}</p>
                <div><label htmlFor="date" className="block text-sm font-medium text-gray-300 mb-1">Date</label><input type="date" id="date" value={date} onChange={e => setDate(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3" required /></div>
                { (entryType === 'asset' || entryType === 'addLiability') && <div><label htmlFor="name" className="block text-sm font-medium text-gray-300 mb-1">{entryType === 'asset' ? 'Asset Name' : 'Liability Name'}</label><input type="text" id="name" value={entryType === 'asset' ? assetName : liabilityName} onChange={e => entryType === 'asset' ? setAssetName(e.target.value) : setLiabilityName(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3" required /></div> }
                <div className="flex space-x-4"><div className="flex-grow"><label htmlFor="amount" className="block text-sm font-medium text-gray-300 mb-1">{entryType === 'addLiability' ? 'Total Amount' : 'Amount'}</label><input type="number" id="amount" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3" required /></div><div><label htmlFor="currency" className="block text-sm font-medium text-gray-300 mb-1">Currency</label><select id="currency" value={currency} onChange={e => setCurrency(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3"><option value="EUR">EUR (€)</option><option value="INR">INR (₹)</option></select></div></div>
                {entryType === 'expense' && (<><div><label htmlFor="category" className="block text-sm font-medium text-gray-300 mb-1">Category</label><select id="category" value={category} onChange={e => setCategory(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3">{categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}</select></div><div><label htmlFor="payer" className="block text-sm font-medium text-gray-300 mb-1">Payer</label><select id="payer" value={payer} onChange={e => setPayer(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3"><option value="Husband">Husband</option><option value="Wife">Wife</option></select></div></>)}
                {(entryType === 'savings' || entryType === 'savingsWithdrawal') && (<div><label htmlFor="saver" className="block text-sm font-medium text-gray-300 mb-1">Account</label><select id="saver" value={saver} onChange={e => setSaver(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3"><option value="Husband">Husband</option><option value="Wife">Wife</option></select></div>)}
                {entryType === 'savings' && (<div className="flex items-center pt-2"><input id="isOpeningBalance" type="checkbox" checked={isOpeningBalance} onChange={(e) => setIsOpeningBalance(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-cyan-600" /><label htmlFor="isOpeningBalance" className="ml-3 text-sm text-gray-300">This is an opening balance</label></div>)}
                {entryType === 'income' && (<div><label htmlFor="source" className="block text-sm font-medium text-gray-300 mb-1">Source</label><select id="source" value={source} onChange={e => setSource(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3"><option value="Husband">Husband's Salary</option><option value="Wife">Wife's Salary</option><option value="Other">Other</option></select></div>)}
                {entryType === 'payLiability' && (<><div><label htmlFor="liabilityId" className="block text-sm font-medium text-gray-300 mb-1">Liability</label><select id="liabilityId" value={liabilityId} onChange={e => setLiabilityId(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3" required><option value="">Select a Liability</option>{liabilities.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div><div><label htmlFor="payer" className="block text-sm font-medium text-gray-300 mb-1">Payer</label><select id="payer" value={payer} onChange={e => setPayer(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3"><option value="Husband">Husband</option><option value="Wife">Wife</option></select></div></>)}
                <div><label htmlFor="description" className="block text-sm font-medium text-gray-300 mb-1">Description (Optional)</label><input type="text" id="description" value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-3" /></div>
                <div><button type="submit" className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-3 px-4 rounded-md transition">Submit</button></div>
            </form>
        </div>
    );
});

// --- History Page Component (Memoized) ---
const HistoryPage = React.memo(function HistoryPage({ user, transactions, incomes }) {
    const [filter, setFilter] = React.useState('all');

    // This effect runs once to clean up very old transactions.
    React.useEffect(() => {
        const autoDeleteOldTransactions = async () => {
            if (!user) return;

            const threeYearsAgo = new Date();
            threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
            const cutoffDate = threeYearsAgo.toISOString().split('T')[0];

            const collectionsToDeleteFrom = ['transactions', 'incomes'];
            for (const collectionName of collectionsToDeleteFrom) {
                const q = query(collection(db, `artifacts/${appId}/users/${user.uid}/${collectionName}`), where("date", "<", cutoffDate));
                const snapshot = await getDocs(q);
                
                if (snapshot.empty) continue;

                // Use a batch write for efficient deletion.
                const batch = writeBatch(db);
                snapshot.docs.forEach(docSnapshot => {
                    batch.delete(docSnapshot.ref);
                });
                await batch.commit();
                console.log(`Batch deleted ${snapshot.size} old documents from ${collectionName}.`);
            }
        };
        autoDeleteOldTransactions();
    }, [user]);

    const filteredEntries = React.useMemo(() => {
        const allEntries = [...transactions.map(t => ({ ...t, collection: 'transactions' })), ...incomes.map(i => ({ ...i, collection: 'incomes', category: i.source }))]
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        
        if (filter === 'all') return allEntries;
        const cutoff = getCutoffDate(parseInt(filter));
        return allEntries.filter(entry => new Date(entry.date) >= cutoff);
    }, [transactions, incomes, filter]);

    return (
        <div className="max-w-4xl mx-auto bg-gray-800 p-8 rounded-lg shadow-lg">
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold text-cyan-400">Transaction History</h2>
                <div className="flex space-x-2">
                    <button onClick={() => setFilter('all')} className={`px-3 py-1 text-sm rounded-md ${filter === 'all' ? 'bg-cyan-600' : 'bg-gray-700'}`}>All</button>
                    <button onClick={() => setFilter('3')} className={`px-3 py-1 text-sm rounded-md ${filter === '3' ? 'bg-cyan-600' : 'bg-gray-700'}`}>3M</button>
                    <button onClick={() => setFilter('6')} className={`px-3 py-1 text-sm rounded-md ${filter === '6' ? 'bg-cyan-600' : 'bg-gray-700'}`}>6M</button>
                    <button onClick={() => setFilter('12')} className={`px-3 py-1 text-sm rounded-md ${filter === '12' ? 'bg-cyan-600' : 'bg-gray-700'}`}>12M</button>
                </div>
            </div>
            <ul className="space-y-3">
                {filteredEntries.map(entry => {
                    const isExpense = ['expense', 'liabilityPayment'].includes(entry.type);
                    const color = isExpense ? 'text-red-400' : 'text-green-400';
                    const symbol = entry.currency === 'EUR' ? '€' : '₹';
                    return (
                        <li key={entry.id} className="flex justify-between items-center bg-gray-700 p-3 rounded-md">
                            <div>
                                <p className="font-semibold capitalize">{entry.description || entry.category || entry.name}</p>
                                <p className="text-sm text-gray-400">{new Date(entry.date).toLocaleDateString()} - {entry.payer || entry.saver || entry.source}</p>
                            </div>
                            <span className={`font-bold ${color}`}>{symbol}{entry.amount.toFixed(2)}</span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
});

// --- Budget Page Component (Memoized) ---
const BudgetPage = React.memo(function BudgetPage({ user, budgets, selectedDate, categories, setCategories }) {
    const [newBudgets, setNewBudgets] = React.useState(budgets);
    const [newCategory, setNewCategory] = React.useState('');
    React.useEffect(() => setNewBudgets(budgets), [budgets]);

    const handleBudgetChange = React.useCallback((category, value) => setNewBudgets(prev => ({ ...prev, [category]: parseFloat(value) || 0 })), []);
    
    const handleSaveCategories = React.useCallback(async (updatedCategories) => {
        if (user) {
            await setDoc(doc(db, `artifacts/${appId}/users/${user.uid}/categories`, 'userCategories'), { list: updatedCategories });
            setCategories(updatedCategories);
        }
    }, [user, setCategories]);
    
    const handleAddCategory = React.useCallback(() => {
        if (newCategory && !categories.includes(newCategory)) {
            handleSaveCategories([...categories, newCategory]);
            setNewCategory('');
        }
    }, [newCategory, categories, handleSaveCategories]);

    const handleDeleteCategory = React.useCallback((categoryToDelete) => {
        handleSaveCategories(categories.filter(c => c !== categoryToDelete));
    }, [categories, handleSaveCategories]);

    const handleSaveBudgets = React.useCallback(async () => {
        if (!user) return;
        const budgetId = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}`;
        try {
            await setDoc(doc(db, `artifacts/${appId}/users/${user.uid}/budgets`, budgetId), newBudgets, { merge: true });
        } catch (error) { console.error("Error saving budgets: ", error); }
    }, [user, selectedDate, newBudgets]);

    return (
        <div className="max-w-2xl mx-auto bg-gray-800 p-8 rounded-lg shadow-lg">
            <h2 className="text-2xl font-bold text-cyan-400 mb-6">Manage Categories</h2>
            <div className="flex space-x-2 mb-6"><input type="text" value={newCategory} onChange={e => setNewCategory(e.target.value)} className="flex-grow bg-gray-700 border border-gray-600 rounded-md p-2" placeholder="New category name" /><button onClick={handleAddCategory} className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-2 px-4 rounded-md">Add</button></div>
            <h2 className="text-2xl font-bold text-cyan-400 mb-6">Manage Budgets for {selectedDate.toLocaleString('default', { month: 'long', year: 'numeric' })} (in EUR)</h2>
            <div className="space-y-4">{categories.map(category => (<div key={category} className="flex items-center justify-between"><label className="text-lg capitalize font-medium">{category}</label><div className="flex items-center space-x-2"><span className="text-lg font-semibold text-gray-400">€</span><input type="number" value={newBudgets[category] || ''} onChange={e => handleBudgetChange(category, e.target.value)} className="w-32 bg-gray-700 border border-gray-600 rounded-md p-2 text-right" placeholder="0.00" /><button onClick={() => handleDeleteCategory(category)} className="text-red-500 hover:text-red-400">X</button></div></div>))}</div>
            <div className="mt-8"><button onClick={handleSaveBudgets} className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-3 px-4 rounded-md transition">Save Budgets</button></div>
        </div>
    );
});

// --- Recurring Page Component (Memoized) ---
const RecurringPage = React.memo(function RecurringPage({ user, recurring, categories }) {
    const [type, setType] = React.useState('expense');
    const [description, setDescription] = React.useState('');
    const [amount, setAmount] = React.useState('');
    const [currency, setCurrency] = React.useState('EUR');
    const [category, setCategory] = React.useState(categories[0]);
    const [payer, setPayer] = React.useState('Husband');
    const [source, setSource] = React.useState('Husband');
    const [frequency, setFrequency] = React.useState('monthly');
    const [startDate, setStartDate] = React.useState(new Date().toISOString().split('T')[0]);

    const handleSubmit = React.useCallback(async (e) => {
        e.preventDefault();
        if (!user || !amount || !description) return;

        const details = type === 'expense' ? { type, category, payer, amount: parseFloat(amount), currency, description } : { type, source, amount: parseFloat(amount), currency, description };
        const newRecurringItem = { type, frequency, startDate, details, lastProcessed: null };

        try {
            await addDoc(collection(db, `artifacts/${appId}/users/${user.uid}/recurring`), newRecurringItem);
            setDescription(''); setAmount('');
        } catch (error) {
            console.error("Error adding recurring item:", error);
        }
    }, [user, amount, description, type, category, payer, currency, source, frequency, startDate]);
    
    const handleDelete = React.useCallback(async (id) => {
        if (user) {
            try { await deleteDoc(doc(db, `artifacts/${appId}/users/${user.uid}/recurring`, id)); }
            catch (error) { console.error("Error deleting recurring item:", error); }
        }
    }, [user]);

    return (
        <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="bg-gray-800 p-8 rounded-lg shadow-lg">
                <h2 className="text-2xl font-bold text-cyan-400 mb-6">Add Recurring Entry</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="flex space-x-2"><button type="button" onClick={() => setType('expense')} className={`flex-1 py-2 rounded-md ${type === 'expense' ? 'bg-cyan-600' : 'bg-gray-700'}`}>Expense</button><button type="button" onClick={() => setType('income')} className={`flex-1 py-2 rounded-md ${type === 'income' ? 'bg-cyan-600' : 'bg-gray-700'}`}>Income</button></div>
                    <div><label className="block text-sm">Description</label><input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md" required /></div>
                    <div className="flex space-x-4"><div className="flex-grow"><label className="block text-sm">Amount</label><input type="number" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md" required /></div><div><label className="block text-sm">Currency</label><select value={currency} onChange={e => setCurrency(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md"><option value="EUR">EUR</option><option value="INR">INR</option></select></div></div>
                    {type === 'expense' ? (<div><label className="block text-sm">Category</label><select value={category} onChange={e => setCategory(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md">{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></div>) : (<div><label className="block text-sm">Source</label><select value={source} onChange={e => setSource(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md"><option value="Husband">Husband's Salary</option><option value="Wife">Wife's Salary</option><option value="Other">Other</option></select></div>)}
                    <div className="flex space-x-4"><div><label className="block text-sm">Frequency</label><select value={frequency} onChange={e => setFrequency(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></div><div><label className="block text-sm">Start Date</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md" /></div></div>
                    <button type="submit" className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-3 px-4 rounded-md transition">Add Recurring</button>
                </form>
            </div>
            <div className="bg-gray-800 p-8 rounded-lg shadow-lg">
                <h2 className="text-2xl font-bold text-cyan-400 mb-6">Scheduled Items</h2>
                <ul className="space-y-3">{recurring.map(item => (<li key={item.id} className="flex justify-between items-center bg-gray-700 p-3 rounded-md"><div><p className="font-semibold capitalize">{item.details.description}</p><p className="text-sm text-gray-400 capitalize">{item.frequency} - {item.details.currency === 'EUR' ? '€' : '₹'}{item.details.amount}</p></div><button onClick={() => handleDelete(item.id)} className="text-red-500 hover:text-red-400">Delete</button></li>))}</ul>
            </div>
        </div>
    );
});

// --- CSV Import Modal Component (Memoized) ---
const ImportModal = React.memo(function ImportModal({ isOpen, onClose, user, categories }) {
    const [transactionsToReview, setTransactionsToReview] = React.useState([]);
    const [currentIndex, setCurrentIndex] = React.useState(0);
    const [currentTransactionData, setCurrentTransactionData] = React.useState(null);

    React.useEffect(() => {
        if (transactionsToReview.length > 0 && currentIndex < transactionsToReview.length) {
            const current = transactionsToReview[currentIndex];
            const isDebit = current.debit && parseFloat(current.debit) > 0;
            setCurrentTransactionData({
                date: current.date,
                description: current.description,
                amount: parseFloat(isDebit ? current.debit : current.credit),
                type: isDebit ? 'expense' : 'income', // Default type
                category: categories[0],
                payer: 'Husband',
                saver: 'Husband',
                source: 'Husband'
            });
        } else {
            setCurrentTransactionData(null);
        }
    }, [transactionsToReview, currentIndex, categories]);

    const handleFileChange = React.useCallback((event) => {
        const file = event.target.files[0];
        if (file && window.Papa) {
            window.Papa.parse(file, {
                complete: (results) => {
                    const parsedData = results.data
                        .slice(1) // Skip header row
                        .map(row => ({
                            date: row[0],
                            description: row[1],
                            debit: row[2],
                            credit: row[3]
                        }))
                        .filter(row => row.date && (row.debit || row.credit)); // Ensure row has data

                    const formattedData = parsedData.map(row => {
                        const dateParts = row.date.split('/');
                        const formattedDate = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`).toISOString().split('T')[0];
                        return { ...row, date: formattedDate };
                    });
                    setTransactionsToReview(formattedData);
                    setCurrentIndex(0);
                }
            });
        }
    }, []);

    const handleNext = React.useCallback(() => {
        if (currentIndex < transactionsToReview.length - 1) {
            setCurrentIndex(currentIndex + 1);
        } else {
            // End of review
            setTransactionsToReview([]);
            setCurrentIndex(0);
            onClose();
        }
    }, [currentIndex, transactionsToReview.length, onClose]);

    const handleSave = React.useCallback(async () => {
        if (!user || !currentTransactionData) return;

        const { type, amount, date, description, category, payer, saver, source } = currentTransactionData;
        const userId = user.uid;
        let collectionName;
        let docData = { date, description, amount, currency: 'EUR' };

        switch (type) {
            case 'expense':
                collectionName = 'transactions';
                Object.assign(docData, { type: 'expense', category, payer });
                break;
            case 'savings':
                collectionName = 'transactions';
                Object.assign(docData, { type: 'savings', saver });
                break;
            case 'income':
                collectionName = 'incomes';
                Object.assign(docData, { type: 'income', source });
                break;
            case 'savingsWithdrawal':
                collectionName = 'transactions';
                Object.assign(docData, { type: 'savingsWithdrawal', saver });
                break;
            default:
                return;
        }

        try {
            await addDoc(collection(db, `artifacts/${appId}/users/${userId}/${collectionName}`), docData);
            handleNext();
        } catch (error) {
            console.error("Error saving imported document: ", error);
        }
    }, [user, currentTransactionData, handleNext]);

    if (!isOpen) return null;

    const isDebit = transactionsToReview.length > 0 && currentIndex < transactionsToReview.length && transactionsToReview[currentIndex].debit > 0;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50">
            <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-2xl text-white">
                <h2 className="text-2xl font-bold text-cyan-400 mb-6">Import Transactions</h2>
                {transactionsToReview.length === 0 ? (
                    <div>
                        <p className="mb-4">Select a CSV file to import. The format should be: Date (DD/MM/YYYY), Description, Debit, Credit.</p>
                        <input type="file" accept=".csv" onChange={handleFileChange} className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-cyan-600 file:text-white hover:file:bg-cyan-700"/>
                    </div>
                ) : currentTransactionData ? (
                    <div className="space-y-4">
                        <h3 className="text-lg font-semibold">Reviewing Transaction {currentIndex + 1} of {transactionsToReview.length}</h3>
                        <p><span className="font-bold">Date:</span> {new Date(currentTransactionData.date).toLocaleDateString()}</p>
                        <p><span className="font-bold">Amount:</span> <span className={isDebit ? 'text-red-400' : 'text-green-400'}>€{currentTransactionData.amount.toFixed(2)}</span></p>
                        
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1">Description</label>
                            <input type="text" value={currentTransactionData.description} onChange={(e) => setCurrentTransactionData({...currentTransactionData, description: e.target.value})} className="w-full bg-gray-700 border border-gray-600 rounded-md p-2"/>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1">Transaction Type</label>
                            <select value={currentTransactionData.type} onChange={(e) => setCurrentTransactionData({...currentTransactionData, type: e.target.value})} className="w-full bg-gray-700 border border-gray-600 rounded-md p-2">
                                {isDebit ? (
                                    <>
                                        <option value="expense">Expense</option>
                                        <option value="savings">Transfer to Savings</option>
                                    </>
                                ) : (
                                    <>
                                        <option value="income">Income</option>
                                        <option value="savingsWithdrawal">Transfer from Savings</option>
                                    </>
                                )}
                            </select>
                        </div>
                        
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1">
                                {currentTransactionData.type === 'expense' ? 'Payer' : 
                                 currentTransactionData.type === 'income' ? 'Source' : 'Account'}
                            </label>
                            <select 
                                value={
                                    currentTransactionData.type === 'expense' ? currentTransactionData.payer :
                                    currentTransactionData.type === 'income' ? currentTransactionData.source : currentTransactionData.saver
                                } 
                                onChange={(e) => {
                                    const person = e.target.value;
                                    setCurrentTransactionData({
                                        ...currentTransactionData, 
                                        payer: person, 
                                        saver: person, 
                                        source: person
                                    });
                                }} 
                                className="w-full bg-gray-700 border border-gray-600 rounded-md p-2"
                            >
                                {currentTransactionData.type === 'income' ? (
                                    <>
                                        <option value="Husband">Husband's Salary</option>
                                        <option value="Wife">Wife's Salary</option>
                                        <option value="Other">Other</option>
                                    </>
                                ) : (
                                    <>
                                        <option value="Husband">Husband</option>
                                        <option value="Wife">Wife</option>
                                    </>
                                )}
                            </select>
                        </div>

                        {currentTransactionData.type === 'expense' && (
                             <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">Category</label>
                                <select value={currentTransactionData.category} onChange={(e) => setCurrentTransactionData({...currentTransactionData, category: e.target.value})} className="w-full bg-gray-700 border border-gray-600 rounded-md p-2">
                                    {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                                </select>
                            </div>
                        )}

                        <div className="flex justify-end space-x-4 pt-4">
                            <button onClick={handleNext} className="px-6 py-2 rounded-md bg-gray-600 hover:bg-gray-500 transition">Skip</button>
                            <button onClick={handleSave} className="px-6 py-2 rounded-md bg-cyan-600 hover:bg-cyan-700 transition">OK</button>
                        </div>
                    </div>
                ) : null}
                 <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white text-2xl">&times;</button>
            </div>
        </div>
    );
});


// --- Analysis Page Component (Memoized) ---
const AnalysisPage = React.memo(function AnalysisPage({ user, transactions, incomes, currencyRates, categories }) {
    const [isImportModalOpen, setIsImportModalOpen] = React.useState(false);
    
    const toEUR = React.useCallback((amount, currency) => currency === 'INR' ? amount / currencyRates.INR : amount, [currencyRates]);

    // Yearly Summary
    const { totalYearlyIncome, totalYearlyExpenses, netYearlySavings } = React.useMemo(() => {
        const currentYear = new Date().getFullYear();
        const yearlyIncomes = incomes.filter(i => new Date(i.date).getFullYear() === currentYear);
        const yearlyTransactions = transactions.filter(t => new Date(t.date).getFullYear() === currentYear);

        const totalYearlyIncome = yearlyIncomes.reduce((sum, i) => sum + toEUR(i.amount, i.currency), 0);
        const totalYearlyExpenses = yearlyTransactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + toEUR(t.amount, t.currency), 0);
        const netYearlySavings = totalYearlyIncome - totalYearlyExpenses;
        return { totalYearlyIncome, totalYearlyExpenses, netYearlySavings };
    }, [incomes, transactions, toEUR]);

    // Trend Data for the last 12 months
    const trendData = React.useMemo(() => {
        return Array.from({ length: 12 }, (_, i) => {
            const d = new Date();
            d.setDate(1); // Set to 1st to avoid month overflow issues
            d.setMonth(d.getMonth() - i);
            const month = d.toLocaleString('default', { month: 'short' });
            const year = d.getFullYear();
            const monthKey = `${month} '${String(year).slice(2)}`;
            
            const monthlyIncome = incomes.filter(inc => new Date(inc.date).getMonth() === d.getMonth() && new Date(inc.date).getFullYear() === year).reduce((sum, inc) => sum + toEUR(inc.amount, inc.currency), 0);
            const monthlyExpenses = transactions.filter(t => t.type === 'expense' && new Date(t.date).getMonth() === d.getMonth() && new Date(t.date).getFullYear() === year).reduce((sum, t) => sum + toEUR(t.amount, t.currency), 0);
    
            return { month: monthKey, income: monthlyIncome, expenses: monthlyExpenses };
        }).reverse();
    }, [transactions, incomes, toEUR]);

    const exportToCSV = React.useCallback(() => {
        const allData = [...incomes, ...transactions];
        const headers = ['Date', 'Type', 'Description', 'Category/Source', 'Amount', 'Currency', 'Payer/Saver'];
        const csvRows = [headers.join(',')];

        for (const row of allData) {
            const values = [
                row.date,
                row.type,
                row.description || '',
                row.category || row.source || '',
                row.amount,
                row.currency,
                row.payer || row.saver || ''
            ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','); // Handle quotes in data
            csvRows.push(values);
        }

        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', 'finance_history.csv');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }, [incomes, transactions]);

    return (
        <div className="space-y-8">
            <ImportModal isOpen={isImportModalOpen} onClose={() => setIsImportModalOpen(false)} user={user} categories={categories} />
            <div className="bg-gray-800 p-6 rounded-lg shadow-lg">
                <h2 className="text-2xl font-bold text-cyan-400 mb-4">Yearly Summary ({new Date().getFullYear()})</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                    <div><p className="text-lg text-gray-400">Total Income</p><p className="text-3xl font-bold text-green-400">€{totalYearlyIncome.toFixed(2)}</p></div>
                    <div><p className="text-lg text-gray-400">Total Expenses</p><p className="text-3xl font-bold text-red-400">€{totalYearlyExpenses.toFixed(2)}</p></div>
                    <div><p className="text-lg text-gray-400">Net Savings</p><p className="text-3xl font-bold">€{netYearlySavings.toFixed(2)}</p></div>
                </div>
            </div>

            <div className="bg-gray-800 p-6 rounded-lg shadow-lg">
                <h2 className="text-2xl font-bold text-cyan-400 mb-4">12-Month Trend (Income vs Expenses in EUR)</h2>
                <div className="w-full h-80">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={trendData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#4A5568" />
                            <XAxis dataKey="month" stroke="#A0AEC0" />
                            <YAxis stroke="#A0AEC0" tickFormatter={(value) => `€${value}`} />
                            <Tooltip
                                contentStyle={{ backgroundColor: '#2D3748', border: '1px solid #4A5568', borderRadius: '0.5rem' }}
                                labelStyle={{ color: '#E2E8F0', fontWeight: 'bold' }}
                                itemStyle={{ fontWeight: 'normal' }}
                                formatter={(value, name) => [`€${value.toFixed(2)}`, name.charAt(0).toUpperCase() + name.slice(1)]}
                            />
                            <Legend wrapperStyle={{ color: '#E2E8F0' }} />
                            <Bar dataKey="income" fill="#48BB78" name="Income" radius={[4, 4, 0, 0]} />
                            <Bar dataKey="expenses" fill="#F56565" name="Expenses" radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>

            <div className="bg-gray-800 p-6 rounded-lg shadow-lg text-center">
                 <h2 className="text-2xl font-bold text-cyan-400 mb-4">Data Management</h2>
                 <div className="flex justify-center space-x-4">
                    <button onClick={() => setIsImportModalOpen(true)} className="bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-6 rounded-md transition">Import from CSV</button>
                    <button onClick={exportToCSV} className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-3 px-6 rounded-md transition">Export All Data to CSV</button>
                 </div>
            </div>
        </div>
    );
});
