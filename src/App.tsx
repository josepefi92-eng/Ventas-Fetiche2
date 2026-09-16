/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  Trash2, 
  CheckCircle2, 
  History, 
  Menu as MenuIcon, 
  X, 
  ChevronRight, 
  Moon, 
  Sun, 
  Coffee, 
  Utensils, 
  Settings,
  PlusCircle,
  MinusCircle,
  CreditCard,
  UserPlus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  doc, 
  updateDoc, 
  query, 
  orderBy, 
  setDoc,
  getDocs,
  writeBatch,
  getDocFromServer
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './lib/firebase';

// Validate Connection to Firestore
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// --- Types ---
interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
}

interface AccountItem {
  id: string;
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

interface Account {
  id: string;
  name: string;
  items: AccountItem[];
  status: 'open' | 'closed';
  createdAt: number;
  closedAt?: number;
  total: number;
}

// --- Initial Data ---
const DEFAULT_PRODUCTS: Product[] = [
  { id: '1', name: 'Café Espresso', price: 2.5, category: 'Bebida' },
  { id: '2', name: 'Capuchino', price: 3.5, category: 'Bebida' },
  { id: '3', name: 'Tarta de Chocolate', price: 4.0, category: 'Comida' },
  { id: '4', name: 'Cerveza Artesanal', price: 5.5, category: 'Bebida' },
  { id: '5', name: 'Sándwich Jamón', price: 6.5, category: 'Comida' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<'accounts' | 'menu' | 'history'>('accounts');
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isNewAccountModalOpen, setIsNewAccountModalOpen] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');

  const [accountToDelete, setAccountToDelete] = useState<string | null>(null);

  // --- Theme & Real-time Firestore Sync ---
  useEffect(() => {
    const savedTheme = localStorage.getItem('pos_theme');
    if (savedTheme === 'dark') setIsDarkMode(true);

    // Sync Products
    const qProducts = query(collection(db, 'products'), orderBy('name', 'asc'));
    const unsubscribeProducts = onSnapshot(qProducts, async (snapshot) => {
      if (snapshot.empty) {
        // Seed default products if collection is empty
        try {
          const batch = writeBatch(db);
          DEFAULT_PRODUCTS.forEach(dp => {
            const docRef = doc(collection(db, 'products'));
            batch.set(docRef, { name: dp.name, price: dp.price, category: dp.category });
          });
          await batch.commit();
        } catch (e) {
          console.error("Error seeding default products", e);
        }
      } else {
        const p = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Product));
        setProducts(p);
      }
      setIsLoading(false);
    }, (error) => {
      setIsLoading(false);
      handleFirestoreError(error, OperationType.GET, 'products');
    });

    // Sync Accounts
    const qAccounts = query(collection(db, 'accounts'), orderBy('createdAt', 'desc'));
    const unsubscribeAccounts = onSnapshot(qAccounts, (snapshot) => {
      const accs: Account[] = snapshot.docs.map(docSnapshot => {
        const accData = docSnapshot.data();
        const items: AccountItem[] = Array.isArray(accData.items) ? accData.items : [];

        // Legacy fallback: if items subcollection existed but not array, migrate in background
        if (!accData.items && !accData._migrated) {
          getDocs(collection(db, 'accounts', docSnapshot.id, 'items')).then(snap => {
            if (!snap.empty) {
              const legacyItems = snap.docs.map(itemDoc => ({ id: itemDoc.id, ...itemDoc.data() } as AccountItem));
              const legacyTotal = legacyItems.reduce((sum, it) => sum + (Number(it.price) * it.quantity), 0);
              updateDoc(doc(db, 'accounts', docSnapshot.id), {
                items: legacyItems,
                total: legacyTotal,
                _migrated: true
              }).catch(() => {});
            }
          }).catch(() => {});
        }

        return {
          id: docSnapshot.id,
          name: accData.name || '',
          status: accData.status || 'open',
          total: Number(accData.total) || 0,
          createdAt: accData.createdAt || Date.now(),
          closedAt: accData.closedAt,
          items
        } as Account;
      });

      // Maintain any local pending accounts until synced
      setAccounts(prev => {
        const tempOnes = prev.filter(a => a.id.startsWith('temp_'));
        const remainingTemps = tempOnes.filter(t => !accs.some(a => a.name === t.name));
        return [...remainingTemps, ...accs];
      });
    }, (error) => handleFirestoreError(error, OperationType.GET, 'accounts'));

    return () => {
      unsubscribeProducts();
      unsubscribeAccounts();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('pos_theme', isDarkMode ? 'dark' : 'light');
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDarkMode]);

  // --- Handlers ---
  const createAccount = async () => {
    if (!newAccountName.trim()) return;
    
    const names = newAccountName
      .split(/[\n,]/)
      .map(name => name.trim())
      .filter(name => name !== '');

    if (names.length === 0) return;

    // 1. Instant optimistic update
    const newAccountsData = names.map(name => ({
      name,
      status: 'open' as const,
      total: 0,
      items: [] as AccountItem[],
      createdAt: Date.now()
    }));

    const optimisticAccounts: Account[] = newAccountsData.map(acc => ({
      ...acc,
      id: 'temp_' + crypto.randomUUID()
    }));

    setAccounts(prev => [...optimisticAccounts, ...prev]);
    setNewAccountName('');
    setIsNewAccountModalOpen(false);

    if (optimisticAccounts.length === 1) {
      setSelectedAccountId(optimisticAccounts[0].id);
    }

    // 2. Persist to Firestore
    try {
      const batch = writeBatch(db);
      const createdIds: string[] = [];

      for (const accData of newAccountsData) {
        const accRef = doc(collection(db, 'accounts'));
        batch.set(accRef, accData);
        createdIds.push(accRef.id);
      }

      await batch.commit();

      if (createdIds.length === 1) {
        setSelectedAccountId(createdIds[0]);
      }
    } catch (error) {
      setAccounts(prev => prev.filter(a => !a.id.startsWith('temp_')));
      handleFirestoreError(error, OperationType.WRITE, 'accounts');
    }
  };

  const addProductToAccount = async (accountId: string, product: Product) => {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;

    const existingItemIndex = acc.items.findIndex(item => item.productId === product.id);
    let newItems: AccountItem[] = [...acc.items];

    if (existingItemIndex > -1) {
      newItems[existingItemIndex] = {
        ...newItems[existingItemIndex],
        quantity: newItems[existingItemIndex].quantity + 1
      };
    } else {
      newItems.push({
        id: crypto.randomUUID(),
        productId: product.id,
        name: product.name,
        price: Number(product.price),
        quantity: 1
      });
    }

    const newTotal = newItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);

    // Instant optimistic update (0ms UI feedback)
    setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, items: newItems, total: newTotal } : a));
    if ('vibrate' in navigator) navigator.vibrate(10);

    // Persist to Firestore
    if (!accountId.startsWith('temp_')) {
      try {
        await updateDoc(doc(db, 'accounts', accountId), {
          items: newItems,
          total: newTotal
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `accounts/${accountId}`);
      }
    }
  };

  const updateItemQuantity = async (accountId: string, itemId: string, delta: number) => {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;

    const item = acc.items.find(i => i.id === itemId);
    if (!item) return;

    const newQty = item.quantity + delta;
    let newItems: AccountItem[];

    if (newQty <= 0) {
      newItems = acc.items.filter(i => i.id !== itemId);
    } else {
      newItems = acc.items.map(i => i.id === itemId ? { ...i, quantity: newQty } : i);
    }

    const newTotal = newItems.reduce((sum, i) => sum + (Number(i.price) * i.quantity), 0);

    // Instant optimistic update
    setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, items: newItems, total: newTotal } : a));

    if (!accountId.startsWith('temp_')) {
      try {
        await updateDoc(doc(db, 'accounts', accountId), {
          items: newItems,
          total: newTotal
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `accounts/${accountId}`);
      }
    }
  };

  const removeItemFromAccount = async (accountId: string, itemId: string) => {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;

    const newItems = acc.items.filter(i => i.id !== itemId);
    const newTotal = newItems.reduce((sum, i) => sum + (Number(i.price) * i.quantity), 0);

    // Instant optimistic update
    setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, items: newItems, total: newTotal } : a));

    if (!accountId.startsWith('temp_')) {
      try {
        await updateDoc(doc(db, 'accounts', accountId), {
          items: newItems,
          total: newTotal
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `accounts/${accountId}`);
      }
    }
  };

  const closeAccount = async (accountId: string) => {
    // Instant optimistic update
    setAccounts(prev => prev.map(acc => {
      if (acc.id !== accountId) return acc;
      return { ...acc, status: 'closed', closedAt: Date.now() };
    }));
    setSelectedAccountId(null);

    if (!accountId.startsWith('temp_')) {
      try {
        await updateDoc(doc(db, 'accounts', accountId), {
          status: 'closed',
          closedAt: Date.now()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `accounts/${accountId}`);
      }
    }
  };

  const deleteAccount = async (accountId: string) => {
    // Instant optimistic update
    setAccounts(prev => prev.filter(acc => acc.id !== accountId));
    if (selectedAccountId === accountId) setSelectedAccountId(null);
    setAccountToDelete(null);

    if (!accountId.startsWith('temp_')) {
      try {
        await deleteDoc(doc(db, 'accounts', accountId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `accounts/${accountId}`);
      }
    }
  };

  const addProductToCatalog = async (name: string, price: number, category: string) => {
    const tempProduct: Product = {
      id: 'temp_' + crypto.randomUUID(),
      name,
      price: Number(price),
      category
    };
    setProducts(prev => [...prev, tempProduct]);

    try {
      await addDoc(collection(db, 'products'), {
        name,
        price: Number(price),
        category
      });
    } catch (error) {
      setProducts(prev => prev.filter(p => p.id !== tempProduct.id));
      handleFirestoreError(error, OperationType.CREATE, 'products');
    }
  };

  const deleteProductFromCatalog = async (productId: string) => {
    setProducts(prev => prev.filter(p => p.id !== productId));
    if (!productId.startsWith('temp_')) {
      try {
        await deleteDoc(doc(db, 'products', productId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `products/${productId}`);
      }
    }
  };

  const clearHistory = async () => {
    if (confirm('¿Estás seguro de eliminar TODO el historial de ventas? Esta acción no se puede deshacer.')) {
      try {
        const batch = writeBatch(db);
        closedAccounts.forEach(acc => {
          batch.delete(doc(db, 'accounts', acc.id));
        });
        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, 'accounts');
      }
    }
  };

  // --- Derived State ---
  const openAccounts = accounts.filter(acc => acc.status === 'open');
  const closedAccounts = accounts.filter(acc => acc.status === 'closed');
  const selectedAccount = accounts.find(acc => acc.id === selectedAccountId);

  if (isLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDarkMode ? 'bg-neutral-950 text-white' : 'bg-neutral-50 text-neutral-900'}`}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="font-bold animate-pulse">Cargando Sistema...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen transition-colors duration-300 ${isDarkMode ? 'bg-neutral-950 text-neutral-100' : 'bg-neutral-50 text-neutral-900'}`}>
      
      {/* Top Header */}
      <div className={`fixed top-0 left-0 right-0 z-40 bg-white/80 dark:bg-neutral-950/80 backdrop-blur-md border-b dark:border-neutral-800 px-6 py-2 transition-all md:block hidden`}>
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold text-xs shadow-sm">
                <Coffee className="w-4 h-4" />
             </div>
             <span className="font-black text-sm tracking-wider">QUICK POS</span>
          </div>
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            className="p-2 text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-colors"
            title={isDarkMode ? 'Modo Claro' : 'Modo Oscuro'}
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* --- Navigation Bar --- */}
      <nav className={`fixed bottom-0 left-0 right-0 z-50 h-16 flex items-center justify-around border-t ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'} md:top-0 md:bottom-auto`}>
        <div className="flex w-full max-w-4xl mx-auto items-center justify-around">
          <NavItem 
            icon={<Coffee className="w-5 h-5" />} 
            label="Cuentas" 
            isActive={activeTab === 'accounts'} 
            onClick={() => setActiveTab('accounts')} 
            isDarkMode={isDarkMode}
          />
          <NavItem 
            icon={<Settings className="w-5 h-5" />} 
            label="Menú" 
            isActive={activeTab === 'menu'} 
            onClick={() => setActiveTab('menu')} 
            isDarkMode={isDarkMode}
          />
          <NavItem 
            icon={<History className="w-5 h-5" />} 
            label="Historial" 
            isActive={activeTab === 'history'} 
            onClick={() => setActiveTab('history')} 
            isDarkMode={isDarkMode}
          />
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            className="p-3 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            {isDarkMode ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-neutral-600" />}
          </button>
        </div>
      </nav>

      <main className="pb-20 pt-4 md:pt-20 px-4 max-w-6xl mx-auto">
        
        {/* --- ACCOUNTS VIEW --- */}
        {activeTab === 'accounts' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            
            {/* List of Accounts (Left Pane) */}
            <div className={`lg:col-span-4 space-y-4 ${selectedAccountId ? 'hidden lg:block' : 'block'}`}>
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold font-sans">Cuentas Abiertas</h2>
                <button 
                  onClick={() => setIsNewAccountModalOpen(true)}
                  className="bg-primary-600 hover:bg-primary-700 text-white p-2 rounded-full shadow-lg transition-transform active:scale-95 flex items-center gap-2 px-4"
                  style={{ backgroundColor: '#2563eb' }}
                >
                  <UserPlus className="w-5 h-5" />
                  <span className="font-medium">Nueva</span>
                </button>
              </div>

              <div className="space-y-3">
                <AnimatePresence initial={false}>
                  {openAccounts.length === 0 ? (
                    <div className="text-center py-10 opacity-50 italic">No hay cuentas abiertas</div>
                  ) : (
                    openAccounts.map(acc => (
                      <motion.div
                        key={acc.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        onClick={() => setSelectedAccountId(acc.id)}
                        className={`p-4 rounded-xl cursor-pointer border-2 transition-all ${
                          selectedAccountId === acc.id 
                            ? (isDarkMode ? 'bg-neutral-800 border-blue-500 ring-2 ring-blue-500/20' : 'bg-blue-50 border-blue-500 shadow-md')
                            : (isDarkMode ? 'bg-neutral-900 border-neutral-800 hover:border-neutral-700' : 'bg-white border-neutral-100 hover:border-neutral-200 shadow-sm')
                        }`}
                      >
                        <div className="flex justify-between items-center">
                          <div>
                            <h3 className="font-bold text-lg">{acc.name}</h3>
                            <p className="text-sm opacity-60">{acc.items.length} productos</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xl font-black text-blue-600 dark:text-blue-400">${acc.total.toFixed(2)}</p>
                          </div>
                        </div>
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Account Detail (Right Pane) */}
            <div className={`lg:col-span-8 ${selectedAccountId ? 'block' : 'hidden lg:flex items-center justify-center h-64 opacity-30 text-xl italic border-2 border-dashed border-neutral-300 dark:border-neutral-800 rounded-3xl'}`}>
              {selectedAccount ? (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`rounded-3xl border ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'} shadow-xl overflow-hidden`}
                >
                  {/* Header */}
                  <div className={`p-6 border-b flex items-center justify-between ${isDarkMode ? 'bg-neutral-800/50 border-neutral-800' : 'bg-neutral-50 border-neutral-200'}`}>
                    <div className="flex items-center gap-4">
                      <button 
                        onClick={() => setSelectedAccountId(null)}
                        className="lg:hidden p-2 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
                      >
                        <X className="w-6 h-6" />
                      </button>
                      <h3 className="text-2xl font-black uppercase tracking-wider">{selectedAccount.name}</h3>
                    </div>
                      <div className="flex gap-2">
                       <button 
                        onClick={() => setAccountToDelete(selectedAccount.id)}
                        className="p-3 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors"
                      >
                        <Trash2 className="w-6 h-6" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2">
                    {/* Items List */}
                    <div className="p-6 border-r border-neutral-200 dark:border-neutral-800">
                      <div className="flex justify-between items-center mb-4">
                        <h4 className="font-bold uppercase text-xs tracking-widest opacity-50">Consumo</h4>
                        <span className="font-bold text-blue-600">${selectedAccount.total.toFixed(2)}</span>
                      </div>
                      <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                        {selectedAccount.items.length === 0 ? (
                          <p className="text-center py-10 opacity-30 italic">No hay productos seleccionados</p>
                        ) : (
                          selectedAccount.items.map(item => (
                            <div 
                              key={item.id} 
                              className="flex items-center justify-between gap-3 p-2.5 rounded-2xl bg-neutral-100/70 dark:bg-neutral-850/60 border border-neutral-200/60 dark:border-neutral-800/80 transition-all hover:border-neutral-300 dark:hover:border-neutral-700"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-sm truncate">{item.name}</p>
                                <p className="text-xs opacity-60 font-medium">
                                  ${Number(item.price).toFixed(2)} × {item.quantity} = <span className="font-black text-blue-600 dark:text-blue-400">${(Number(item.price) * item.quantity).toFixed(2)}</span>
                                </p>
                              </div>

                              {/* Cantidad controls */}
                              <div className="flex items-center gap-1 bg-white dark:bg-neutral-800 p-1 rounded-xl border border-neutral-200 dark:border-neutral-700 shadow-xs">
                                <button 
                                  onClick={() => updateItemQuantity(selectedAccount.id, item.id, -1)} 
                                  className="p-1 text-neutral-500 hover:text-red-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
                                  title={item.quantity <= 1 ? "Eliminar de la cuenta" : "Disminuir cantidad"}
                                >
                                  <MinusCircle className="w-5 h-5" />
                                </button>
                                <span className="w-6 text-center font-black text-neutral-900 dark:text-white text-base">
                                  {item.quantity}
                                </span>
                                <button 
                                  onClick={() => updateItemQuantity(selectedAccount.id, item.id, 1)} 
                                  className="p-1 text-neutral-500 hover:text-green-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
                                  title="Aumentar cantidad"
                                >
                                  <PlusCircle className="w-5 h-5" />
                                </button>
                              </div>

                              {/* Delete item button */}
                              <button
                                onClick={() => removeItemFromAccount(selectedAccount.id, item.id)}
                                className="p-2 text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl transition-colors shrink-0"
                                title="Eliminar este producto"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                      
                      <div className="mt-8 pt-6 border-t dark:border-neutral-800">
                        <button 
                          disabled={selectedAccount.items.length === 0}
                          onClick={() => closeAccount(selectedAccount.id)}
                          className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:grayscale text-white py-4 rounded-2xl font-bold text-lg shadow-lg flex items-center justify-center gap-3 transition-transform active:scale-95"
                        >
                          <CreditCard className="w-6 h-6" />
                          Cerrar y Pagar
                        </button>
                      </div>
                    </div>

                    {/* Quick Add Grid */}
                    <div className={`p-6 ${isDarkMode ? 'bg-neutral-900/50' : 'bg-neutral-50/50'}`}>
                      <h4 className="font-bold uppercase text-xs tracking-widest opacity-50 mb-4 text-center">Añadir Rápido</h4>
                      <div className="grid grid-cols-2 md:grid-cols-2 gap-3 max-h-[450px] overflow-y-auto pr-2 custom-scrollbar">
                        {products.map(product => (
                          <button
                            key={product.id}
                            onClick={() => addProductToAccount(selectedAccount.id, product)}
                            className={`p-4 rounded-2xl text-left transition-all active:scale-95 border-2 ${
                              isDarkMode 
                                ? 'bg-neutral-800 border-neutral-700 hover:bg-neutral-700' 
                                : 'bg-white border-white hover:border-blue-200 shadow-sm'
                            }`}
                          >
                            <p className="font-bold leading-tight line-clamp-1">{product.name}</p>
                            <p className="text-blue-500 dark:text-blue-400 font-black mt-1">${product.price.toFixed(2)}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : (
                "Selecciona o crea una cuenta para empezar"
              )}
            </div>
          </div>
        )}

        {/* --- MENU MANAGEMENT VIEW --- */}
        {activeTab === 'menu' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-6"
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <h2 className="text-2xl font-bold">Catálogo de Productos</h2>
              <ProductForm onAdd={addProductToCatalog} isDarkMode={isDarkMode} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {products.map(product => (
                <div 
                  key={product.id} 
                  className={`p-5 rounded-2xl border flex flex-col justify-between ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'}`}
                >
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-widest bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-0.5 rounded-full">{product.category}</span>
                    <h3 className="text-lg font-bold mt-2">{product.name}</h3>
                  </div>
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xl font-black">${product.price.toFixed(2)}</span>
                    <button 
                      onClick={() => deleteProductFromCatalog(product.id)}
                      className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* --- HISTORY VIEW --- */}
        {activeTab === 'history' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-8"
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <h2 className="text-2xl font-bold">Historial de Ventas</h2>
              <div className="flex gap-4 items-center">
                <button 
                  onClick={clearHistory}
                  className="text-xs font-bold uppercase tracking-widest opacity-40 hover:opacity-100 hover:text-red-500 transition-all flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  Vaciar Historial
                </button>
                <div className="bg-green-50 dark:bg-green-900/10 p-4 rounded-2xl border border-green-100 dark:border-green-800 flex items-center gap-3">
                  <div className="bg-green-500 p-2 rounded-lg text-white">
                    <History className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-[10px] uppercase font-bold opacity-60">Venta Total Acumulada</p>
                    <p className="text-2xl font-black text-green-600 dark:text-green-400">
                      ${closedAccounts.reduce((sum, acc) => sum + acc.total, 0).toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Daily Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {Object.entries(
                closedAccounts.reduce((groups: Record<string, number>, acc) => {
                  const date = new Date(acc.closedAt || 0).toLocaleDateString();
                  groups[date] = (groups[date] || 0) + acc.total;
                  return groups;
                }, {})
              ).sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime()).map(([date, total]: [string, number]) => (
                <div key={date} className={`p-5 rounded-2xl border ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'}`}>
                  <p className="text-xs font-bold opacity-50 uppercase tracking-widest">{date}</p>
                  <p className="text-2xl font-black mt-1 text-blue-600 dark:text-blue-400">${total.toFixed(2)}</p>
                  <div className="w-full bg-neutral-100 dark:bg-neutral-800 h-2 rounded-full mt-3 overflow-hidden">
                    <div 
                      className="bg-blue-500 h-full" 
                      style={{ width: `${Math.min(100, (total / 1000) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Detailed Table */}
            <div className={`rounded-3xl border overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-100'}`}>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className={`text-[10px] uppercase tracking-widest font-black ${isDarkMode ? 'bg-neutral-800' : 'bg-neutral-50 border-b'}`}>
                    <tr>
                      <th className="px-6 py-4">Cuenta</th>
                      <th className="px-6 py-4">Fecha</th>
                      <th className="px-6 py-4">Total</th>
                      <th className="px-6 py-4 text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-neutral-800">
                    {closedAccounts.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-6 py-10 text-center opacity-40 italic">No hay ventas registradas</td>
                      </tr>
                    ) : (
                      closedAccounts.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).map(acc => (
                        <tr key={acc.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
                          <td className="px-6 py-4">
                            <span className="font-bold">{acc.name}</span>
                            <p className="text-[10px] opacity-50 truncate max-w-[200px]">
                              {acc.items.map(i => `${i.quantity}x ${i.name}`).join(', ')}
                            </p>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <p className="text-sm">{new Date(acc.closedAt || 0).toLocaleDateString()}</p>
                            <p className="text-[10px] opacity-50">{new Date(acc.closedAt || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                          </td>
                          <td className="px-6 py-4 font-black text-green-600">${acc.total.toFixed(2)}</td>
                          <td className="px-6 py-4 text-right">
                            <button 
                              onClick={() => setAccountToDelete(acc.id)}
                              className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

      </main>

      {/* --- New Account Modal --- */}
      <AnimatePresence>
        {isNewAccountModalOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className={`w-full max-w-md p-8 rounded-[2rem] shadow-2xl border ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-100'}`}
            >
              <h3 className="text-2xl font-black mb-6 text-center">NUEVAS CUENTAS</h3>
              <p className="text-xs text-center opacity-50 mb-4">Puedes escribir varios nombres separados por comas o líneas.</p>
              <textarea 
                autoFocus
                rows={4}
                placeholder="Ej: Mesa 1, Mesa 2, Cliente Juan..."
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                className={`w-full p-4 rounded-xl text-lg font-medium border-2 focus:ring-4 outline-none transition-all resize-none ${
                  isDarkMode 
                    ? 'bg-neutral-800 border-neutral-700 focus:border-blue-500 focus:ring-blue-500/20' 
                    : 'bg-neutral-50 border-neutral-100 focus:border-blue-500 focus:ring-blue-500/10'
                }`}
              />
              <div className="grid grid-cols-2 gap-4 mt-8">
                <button 
                  onClick={() => setIsNewAccountModalOpen(false)}
                  className="p-4 rounded-xl font-bold opacity-60 hover:opacity-100 transition-opacity"
                >
                  Cancelar
                </button>
                <button 
                  onClick={createAccount}
                  className="bg-blue-600 hover:bg-blue-700 text-white p-4 rounded-xl font-black shadow-lg shadow-blue-500/20 active:scale-95 transition-transform"
                >
                  Abrir Cuenta
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- Delete Confirmation Modal --- */}
      <AnimatePresence>
        {accountToDelete && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className={`w-full max-w-sm p-8 rounded-[2rem] shadow-2xl border ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-100'}`}
            >
              <div className="text-center">
                <div className="bg-red-100 text-red-600 p-4 rounded-full w-16 h-16 mx-auto mb-4 flex items-center justify-center">
                  <Trash2 className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-black mb-2">¿ELIMINAR CUENTA?</h3>
                <p className="text-sm opacity-60 mb-8">Esta acción es permanente y no se puede deshacer.</p>
                
                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => setAccountToDelete(null)}
                    className="p-4 rounded-xl font-bold opacity-60 hover:opacity-100 transition-opacity"
                  >
                    Cancelar
                  </button>
                  <button 
                    onClick={() => deleteAccount(accountToDelete)}
                    className="bg-red-600 hover:bg-red-700 text-white p-4 rounded-xl font-black shadow-lg shadow-red-500/20 active:scale-95 transition-transform"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- Global Styles --- */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #cbd5e1;
          border-radius: 10px;
        }
        .dark .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #334155;
        }
      `}</style>
    </div>
  );
}

// --- Subcomponents ---

function NavItem({ icon, label, isActive, onClick, isDarkMode }: { icon: React.ReactNode, label: string, isActive: boolean, onClick: () => void, isDarkMode: boolean }) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1 transition-all flex-1 py-1 ${
        isActive 
          ? 'text-blue-500 scale-110' 
          : (isDarkMode ? 'text-neutral-500 hover:text-neutral-300' : 'text-neutral-400 hover:text-neutral-600')
      }`}
    >
      {icon}
      <span className="text-[10px] font-bold uppercase tracking-tight">{label}</span>
      {isActive && (
        <motion.div layoutId="nav-pill" className="w-1 h-1 rounded-full bg-blue-500 mt-0.5" />
      )}
    </button>
  );
}

function ProductForm({ onAdd, isDarkMode }: { onAdd: (name: string, price: number, category: string) => void, isDarkMode: boolean }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('Bebida');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !price) return;
    onAdd(name, parseFloat(price), category);
    setName('');
    setPrice('');
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-2 items-end">
      <div className="flex-1 min-w-[150px]">
        <label className="block text-[10px] font-bold uppercase mb-1 opacity-50">Nombre</label>
        <input 
          type="text" 
          value={name} 
          onChange={e => setName(e.target.value)}
          className={`w-full p-2 px-3 rounded-lg border focus:ring-2 outline-none ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'}`}
          placeholder="Ej: Latte..."
        />
      </div>
      <div className="w-24">
        <label className="block text-[10px] font-bold uppercase mb-1 opacity-50">Precio</label>
        <input 
          type="number" 
          step="0.01" 
          value={price} 
          onChange={e => setPrice(e.target.value)}
          className={`w-full p-2 px-3 rounded-lg border focus:ring-2 outline-none ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'}`}
          placeholder="0.00"
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold uppercase mb-1 opacity-50">Categoría</label>
        <select 
           value={category} 
           onChange={e => setCategory(e.target.value)}
           className={`p-2 px-3 rounded-lg border focus:ring-2 outline-none ${isDarkMode ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'}`}
        >
          <option>Bebida</option>
          <option>Comida</option>
          <option>Botanas</option>
          <option>Cigarros</option>
          <option>Habitaciones</option>
          <option>Otros</option>
        </select>
      </div>
      <button 
        type="submit"
        className="bg-blue-600 hover:bg-blue-700 text-white p-2.5 rounded-lg active:scale-95 transition-transform"
      >
        <Plus className="w-5 h-5" />
      </button>
    </form>
  );
}
