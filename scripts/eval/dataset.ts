export interface EvalCase {
    id: string;
    input: string;
    criteria: string;
    tags: string[];
}

export const EVAL_CASES: EvalCase[] = [
    {
        id: 'js-closures',
        tags: ['javascript', 'language'],
        input: 'Explain JavaScript closures with a concrete example.',
        criteria:
            'Defines a closure as a function bundled with its surrounding lexical scope. Provides a runnable code example showing an inner function accessing an outer function\'s variable after the outer function returns. Mentions at least one real use case (data privacy, partial application, callbacks/event handlers, module pattern).',
    },
    {
        id: 'async-await',
        tags: ['javascript', 'async'],
        input: 'How does async/await work under the hood in JavaScript?',
        criteria:
            'Explains that async functions always return a Promise; await pauses execution until the Promise settles; mentions the microtask queue / event loop; notes that await does not block the thread.',
    },
    {
        id: 'react-hooks',
        tags: ['react', 'frontend'],
        input: 'When should I use useMemo vs useCallback in React?',
        criteria:
            'useMemo memoizes a computed value; useCallback memoizes a function reference. Both take a dependency array. Mentions referential equality for props passed to memoized children, and warns that overuse adds overhead.',
    },
    {
        id: 'next-rendering',
        tags: ['nextjs', 'frontend'],
        input: 'Compare SSR, SSG, and ISR in Next.js. When would you pick each?',
        criteria:
            'Defines SSR (per-request render), SSG (build-time render), and ISR (revalidated static). Correct trade-offs: SSR for dynamic per-request data; SSG for fully static, cacheable content; ISR for mostly-static content with periodic refresh.',
    },
    {
        id: 'ts-generics',
        tags: ['typescript', 'language'],
        input: 'Write a TypeScript generic function that returns the last element of an array, preserving the element type.',
        criteria:
            'Signature like `function last<T>(arr: T[]): T | undefined`. Handles the empty-array case. Uses correct generic syntax. Returning `T | undefined` (or equivalent) is preferred over throwing.',
    },
    {
        id: 'rest-vs-graphql',
        tags: ['api', 'architecture'],
        input: 'What are the practical trade-offs between REST and GraphQL?',
        criteria:
            'Covers over/under-fetching (GraphQL avoids it via flexible queries), schema and typing (GraphQL has a single typed schema), caching (REST benefits from HTTP caching, GraphQL is harder), tooling, and error handling. Acknowledges neither is universally better.',
    },
    {
        id: 'css-flexbox',
        tags: ['css', 'frontend'],
        input: 'How do I vertically and horizontally center a div using flexbox?',
        criteria:
            'Mentions `display: flex` on the parent, `justify-content: center` (main axis), and `align-items: center` (cross axis). Correctly identifies which axis each property controls.',
    },
    {
        id: 'git-rebase',
        tags: ['git', 'tooling'],
        input: 'What is git rebase, and how is it different from git merge?',
        criteria:
            'Rebase replays commits onto a new base, rewriting history; merge creates a merge commit preserving both histories. Mentions the rule of thumb to avoid rebasing already-pushed/shared branches.',
    },
];
