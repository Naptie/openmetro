<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import LanguagesIcon from '@lucide/svelte/icons/languages';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { i18n } from '$lib/i18n.svelte';
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="sm"
        class="gap-1.5 px-2.5"
        aria-label={i18n.t.nav_language()}
        title={i18n.t.nav_language()}
      >
        <LanguagesIcon class="size-4" />
        <span class="text-xs font-semibold tracking-wide uppercase">{i18n.locale}</span>
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="min-w-36" sideOffset={8}>
    <DropdownMenu.Label class="text-xs text-muted-foreground"
      >{i18n.t.nav_language()}</DropdownMenu.Label
    >
    {#each i18n.locales as loc (loc)}
      <DropdownMenu.Item
        class="justify-between gap-4"
        onSelect={() => i18n.set(loc)}
        data-checked={loc === i18n.locale}
      >
        {i18n.name(loc)}
        {#if loc === i18n.locale}
          <CheckIcon class="size-4 text-primary" />
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
