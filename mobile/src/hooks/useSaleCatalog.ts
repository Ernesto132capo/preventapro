import { useCallback, useEffect, useRef, useState } from "react";
import { Client, Category } from "../domain/types";
import { listActiveClients } from "../db/repositories/clients";
import {
  listProducts, listFrequentProducts, listRecentProductsForClient,
  toggleFavoriteLocal, ProductWithPresentations,
} from "../db/repositories/products";
import { listCategories } from "../db/repositories/categories";
import { useDebounce } from "../utils/useDebounce";

export type ProductFilterMode = "all" | "favorites" | "recent" | "frequent" | "category";

interface SaleCatalogOptions {
  isFocused: boolean;
  catalogRevision: number;
  clientSearch: string;
  productSearch: string;
  filterMode: ProductFilterMode;
  selectedCategoryId: string | null;
  selectedClient: Client | null;
}

/** Owns catalog reads; a previous client/filter must never replace the current one. */
export function useSaleCatalog({ isFocused, catalogRevision, clientSearch, productSearch,
  filterMode, selectedCategoryId, selectedClient }: SaleCatalogOptions) {
  const [clients, setClients] = useState<Client[]>([]);
  const [products, setProducts] = useState<ProductWithPresentations[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [recentCount, setRecentCount] = useState(0);
  const [clientError, setClientError] = useState<string | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [loadingClients, setLoadingClients] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const debouncedProductSearch = useDebounce(productSearch, 300);
  const clientId = selectedClient?.id;
  const productSearchForMode = filterMode === "recent" || filterMode === "frequent" ? "" : debouncedProductSearch;
  const previousClientQuery = useRef<string | null>(null);
  const previousProductQuery = useRef<string | null>(null);
  const recentRead = useRef<{ key: string; promise: Promise<ProductWithPresentations[]> } | null>(null);
  const previousRecentClient = useRef<string | undefined>(undefined);
  const productQuery = JSON.stringify([filterMode, productSearchForMode,
    filterMode === "category" ? selectedCategoryId : null, filterMode === "recent" ? clientId : null]);

  function readRecentProducts() {
    if (!clientId) return Promise.resolve([] as ProductWithPresentations[]);
    const key = JSON.stringify([clientId, catalogRevision]);
    if (recentRead.current?.key === key) return recentRead.current.promise;
    const entry = { key, promise: listRecentProductsForClient(clientId) };
    recentRead.current = entry;
    const release = () => { if (recentRead.current === entry) recentRead.current = null; };
    void entry.promise.then(release, release);
    return entry.promise;
  }

  useEffect(() => {
    if (!isFocused) return;
    let current = true;
    setClientError(null);
    if (previousClientQuery.current !== debouncedClientSearch) setClients([]);
    previousClientQuery.current = debouncedClientSearch;
    setLoadingClients(true);
    void listActiveClients(debouncedClientSearch).then(rows => {
      if (current) setClients(rows);
    }).catch(error => {
      if (current) setClientError(error?.message || "No se pudieron cargar los clientes.");
    }).finally(() => { if (current) setLoadingClients(false); });
    return () => { current = false; };
  }, [isFocused, debouncedClientSearch, catalogRevision]);

  useEffect(() => {
    if (!isFocused) return;
    let current = true;
    setProductError(null);
    if (previousProductQuery.current !== productQuery) setProducts([]);
    previousProductQuery.current = productQuery;
    setLoadingProducts(true);
    const read = async () => {
      if (filterMode === "recent" && clientId) {
        const rows = await readRecentProducts();
        if (current) setProducts(rows);
        return;
      }
      if (filterMode === "frequent") {
        const rows = await listFrequentProducts(15);
        if (current) setProducts(rows);
        return;
      }
      const [rows, nextCategories] = await Promise.all([
        listProducts({ search: productSearchForMode,
          categoryId: filterMode === "category" ? selectedCategoryId : undefined,
          onlyFavorites: filterMode === "favorites" ? true : undefined }),
        listCategories(),
      ]);
      if (current) { setProducts(rows); setCategories(nextCategories); }
    };
    void read().catch(error => {
      if (current) setProductError(error?.message || "No se pudieron cargar los productos.");
    }).finally(() => { if (current) setLoadingProducts(false); });
    return () => { current = false; };
  }, [isFocused, productQuery, catalogRevision]);

  useEffect(() => {
    let current = true;
    if (previousRecentClient.current !== clientId) setRecentCount(0);
    previousRecentClient.current = clientId;
    if (isFocused && clientId) {
      void readRecentProducts().then(rows => {
        if (current) setRecentCount(rows.length);
      }).catch(() => { /* El atajo es opcional; el catálogo sigue disponible. */ });
    }
    return () => { current = false; };
  }, [isFocused, clientId, catalogRevision]);

  const handleToggleFavorite = useCallback(async (productId: string) => {
    const favorite = await toggleFavoriteLocal(productId);
    setProducts(previous => previous.map(product => product.id === productId
      ? { ...product, is_favorite: favorite } : product));
  }, []);

  return { clients, setClients, products, categories, recentCount, handleToggleFavorite,
    loadingClients, loadingProducts, catalogError: clientError || productError };
}
