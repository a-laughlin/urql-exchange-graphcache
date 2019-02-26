import { Exchange, formatDocument, Operation, OperationResult } from 'urql';
import { filter, map, merge, pipe, share, tap } from 'wonka';

import { query, write } from './operations';
import Store, { StoreData } from './store';

type OperationResultWithMeta = OperationResult & {
  isComplete: boolean;
};

type OperationMap = Map<number, Operation>;

interface DependentOperations {
  [key: string]: number[];
}

// Returns the given operation with added __typename fields on its query
const addTypeNames = (op: Operation): Operation => ({
  ...op,
  query: formatDocument(op.query),
});

// Retrieves the requestPolicy from an operation
const getRequestPolicy = (op: Operation) => op.context.requestPolicy;

// Returns whether an operation is handled by this exchange
const isQueryOperation = (op: Operation): boolean => {
  const policy = getRequestPolicy(op);
  return (
    op.operationName === 'query' &&
    (policy === 'cache-and-network' ||
      policy === 'cache-first' ||
      policy === 'cache-only')
  );
};

interface CacheOpts {
  initial?: StoreData;
}

export const cacheExchange = ({ initial }: CacheOpts): Exchange => ({
  forward,
  client,
}) => {
  const store = new Store(initial);

  const ops: OperationMap = new Map();
  const deps = Object.create(null) as DependentOperations;

  // Copy an operation and change the requestPolicy to skip the cache
  const toNetworkOnly = (operation: Operation): Operation => ({
    ...operation,
    context: {
      ...operation.context,
      requestPolicy: 'network-only',
    },
  });

  // This accepts an array of dependencies and reexecutes all known operations
  // against the mapping of dependencies to operations
  // The passed triggerOp is ignored however
  const processDependencies = (
    triggerOp: Operation,
    dependencies: string[]
  ) => {
    const pendingOperations = new Set<number>();

    // Collect operations that will be updated due to cache changes
    dependencies.forEach(dep => {
      const keys = deps[dep];
      if (keys !== undefined) {
        deps[dep] = [];
        keys.forEach(key => pendingOperations.add(key));
      }
    });

    // Reexecute collected operations and delete them from the mapping
    pendingOperations.forEach(key => {
      if (key !== triggerOp.key) {
        const op = ops.get(key) as Operation;
        ops.delete(key);
        client.reexecuteOperation(op);
      }
    });
  };

  // This updates the known dependencies for the passed operation
  const updateDependencies = (op: Operation, dependencies: string[]) => {
    dependencies.forEach(dep => {
      const keys = deps[dep] || (deps[dep] = []);
      ops.set(op.key, op);
      keys.push(op.key);
    });
  };

  // Retrieves a query result from cache and adds an `isComplete` hint
  // This hint indicates whether the result is "complete" or not
  const operationResultFromCache = (
    operation: Operation
  ): OperationResultWithMeta => {
    const policy = getRequestPolicy(operation);
    const res = query(store, operation);
    const isComplete = policy === 'cache-only' || res.isComplete;
    if (isComplete) {
      updateDependencies(operation, res.dependencies);
    }

    return {
      operation,
      isComplete,
      data: res.response,
    };
  };

  // Take any OperationResult and update the cache with it
  const updateCacheWithResult = ({
    error,
    data,
    operation,
  }: OperationResult) => {
    if (
      (error === undefined || error.networkError === undefined) &&
      data !== null &&
      data !== undefined
    ) {
      const { dependencies } = write(store, operation, data);

      // Update operations that depend on the updated data (except the current one)
      processDependencies(operation, dependencies);
      // Update this operation's dependencies
      updateDependencies(operation, dependencies);
    }
  };

  return ops$ => {
    const sharedOps$ = pipe(
      ops$,
      map(addTypeNames),
      share
    );

    // Filter by operations that are cacheable and attempt to query them from the cache
    const cache$ = pipe(
      sharedOps$,
      filter(op => isQueryOperation(op)),
      map(operationResultFromCache),
      share
    );

    // Rebound operations that are incomplete, i.e. couldn't be queried just from the cache
    const cacheOps$ = pipe(
      cache$,
      filter(res => !res.isComplete),
      map(res => res.operation)
    );

    // Resolve OperationResults that the cache was able to assemble completely and trigger
    // a network request if the current operation's policy is cache-and-network
    const cacheResult$ = pipe(
      cache$,
      filter(res => res.isComplete),
      tap(({ operation }) => {
        const policy = getRequestPolicy(operation);
        if (policy === 'cache-and-network') {
          const networkOnly = toNetworkOnly(operation);
          client.reexecuteOperation(networkOnly);
        }
      })
    );

    // Forward operations that aren't cacheable and rebound operations
    // Also update the cache with any network results
    const result$ = pipe(
      forward(
        merge([
          pipe(
            sharedOps$,
            filter(op => !isQueryOperation(op))
          ),
          cacheOps$,
        ])
      ),
      tap(updateCacheWithResult)
    );

    return merge([result$, cacheResult$]);
  };
};