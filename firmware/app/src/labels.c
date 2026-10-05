/* labels.c — see labels.h and sp1dev labels/SPEC.md. */
#include "labels.h"
#include "label_rec.h"
#include "nvs_erase.h"
#include "wdt.h"

#include <errno.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/fs/nvs.h>
#include <zephyr/storage/flash_map.h>

#define LBL_FORMAT_ID   0x0001u
#define LBL_ID(n, l)    ((uint16_t)(0x0100u + (unsigned)(n) * LABELS_LAYERS + (unsigned)(l)))

/* The store's format record: present and equal means "this region is a label
 * store, version 1". Absent or different means someone else's bytes (the stale
 * DXP1 banks the 2026-10 flash-map move leaves here, say) -- erase this region,
 * and only this region (FLASH-MAP.md rule 3). */
static const uint8_t FORMAT[4] = { 'F', 'L', 'B', '1' };

static struct nvs_fs lfs;
static bool ready;

static void erase_feed_cb(void *ctx)
{
    (void)ctx;
    feed_wdt();
}

static int erase_sector_cb(void *ctx, int sector)
{
    const struct flash_area *fa = ctx;
    return flash_area_erase(fa, (uint32_t)sector * (uint32_t)lfs.sector_size,
                            (uint32_t)lfs.sector_size);
}

/* Erase the whole feldd_labels partition, a sector at a time, feeding the
 * watchdog before each (16 x up to ~85 ms). */
static int erase_region(void)
{
    const struct flash_area *fa;
    int rc = flash_area_open(FIXED_PARTITION_ID(feldd_labels), &fa);
    if (rc) {
        return rc;
    }
    rc = nvs_erase_sweep((int)lfs.sector_count, erase_feed_cb, erase_sector_cb, (void *)fa);
    flash_area_close(fa);
    return rc;
}

static bool format_ok(void)
{
    uint8_t f[sizeof FORMAT];
    return nvs_read(&lfs, LBL_FORMAT_ID, f, sizeof f) == (ssize_t)sizeof f &&
           memcmp(f, FORMAT, sizeof f) == 0;
}

int labels_init(void)
{
    struct flash_pages_info info;
    int rc;

    lfs.flash_device = FIXED_PARTITION_DEVICE(feldd_labels);
    if (!device_is_ready(lfs.flash_device)) {
        return -ENODEV;
    }
    lfs.offset = FIXED_PARTITION_OFFSET(feldd_labels);
    rc = flash_get_page_info_by_offs(lfs.flash_device, lfs.offset, &info);
    if (rc) {
        return rc;
    }
    lfs.sector_size  = info.size;
    lfs.sector_count = (uint16_t)(FIXED_PARTITION_SIZE(feldd_labels) / info.size);

    rc = nvs_mount(&lfs);
    if (rc == 0 && format_ok()) {
        ready = true;
        return 0;
    }
    /* Not ours, or not mountable: claim the region. */
    rc = erase_region();
    if (rc) {
        return rc;
    }
    rc = nvs_mount(&lfs);
    if (rc) {
        return rc;
    }
    if (nvs_write(&lfs, LBL_FORMAT_ID, FORMAT, sizeof FORMAT) < 0) {
        return -EIO;
    }
    ready = true;
    return 0;
}

int labels_get(uint8_t n, uint8_t l, uint8_t *buf, int cap)
{
    if (!ready) {
        return -ENODEV;
    }
    if (n >= LABELS_SLOTS || l >= LABELS_LAYERS || cap < LABEL_REC_MAX) {
        return -EINVAL;
    }
    ssize_t r = nvs_read(&lfs, LBL_ID(n, l), buf, (size_t)cap);
    if (r == -ENOENT) {
        return 0;
    }
    if (r < 0) {
        return (int)r;
    }
    if (r > cap || !label_rec_valid(buf, (int)r)) {
        (void)nvs_delete(&lfs, LBL_ID(n, l));   /* never hand out a bad record */
        return 0;
    }
    return (int)r;
}

int labels_map(uint8_t m[LABELS_SLOTS])
{
    static uint8_t buf[LABEL_REC_MAX];
    if (!ready) {
        return -ENODEV;
    }
    for (uint8_t n = 0; n < LABELS_SLOTS; n++) {
        m[n] = 0;
        for (uint8_t l = 0; l < LABELS_LAYERS; l++) {
            if (labels_get(n, l, buf, (int)sizeof buf) > 0) {
                m[n] |= (uint8_t)(1u << l);
            }
        }
    }
    return 0;
}

int labels_set(uint8_t n, uint8_t l, const uint8_t *buf, int len)
{
    if (!ready) {
        return -ENODEV;
    }
    if (n >= LABELS_SLOTS || l >= LABELS_LAYERS) {
        return -EINVAL;
    }
    if (len == 0) {
        int rc = nvs_delete(&lfs, LBL_ID(n, l));
        return (rc == -ENOENT) ? 0 : rc;
    }
    if (!label_rec_valid(buf, len)) {
        return -EINVAL;
    }
    ssize_t w = nvs_write(&lfs, LBL_ID(n, l), buf, (size_t)len);
    return (w < 0) ? (int)w : 0;
}

int labels_clear_slot(uint8_t n)
{
    int first = 0;
    for (uint8_t l = 0; l < LABELS_LAYERS; l++) {
        int rc = labels_set(n, l, 0, 0);
        if (rc && !first) {
            first = rc;
        }
        feed_wdt();
    }
    return first;
}

int labels_clear_all(void)
{
    int first = 0;
    for (uint8_t n = 0; n < LABELS_SLOTS; n++) {
        int rc = labels_clear_slot(n);
        if (rc && !first) {
            first = rc;
        }
    }
    return first;
}
