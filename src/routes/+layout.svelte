<script lang="ts">
  import { onMount } from 'svelte';

  onMount(() => {
    const disableContextMenu = (event: MouseEvent) => {
      // Allow the native context menu (cut/copy/paste) in text fields.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
    };

    document.addEventListener('contextmenu', disableContextMenu, { capture: true });

    return () => {
      document.removeEventListener('contextmenu', disableContextMenu, { capture: true });
    };
  });
</script>

<slot />
