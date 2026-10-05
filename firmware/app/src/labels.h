#ifndef LABELS_H
#define LABELS_H
#include <stdint.h>

/* labels.h — the on-device label store (sp1dev labels/SPEC.md §3): one record
 * (label_rec.h) per profile slot × layer, in its own NVS store on the
 * feldd_labels partition, beside the profiles. Writes are immediate (the
 * configurator waits on them). All functions run on the main thread. */

#define LABELS_SLOTS   16
#define LABELS_LAYERS  8

/* Mount at boot, after the profile store. A store that will not mount, or lacks
 * its format record, is erased -- this region only -- and started fresh.
 * 0 ok; <0 labels unavailable (profiles are unaffected). */
int labels_init(void);

/* m[n] bit l set if slot n layer l has a record. 0 ok, <0 unavailable. */
int labels_map(uint8_t m[LABELS_SLOTS]);

/* Copy slot n layer l's record into buf: its length, 0 if none, <0 on error.
 * A stored record that fails validation is deleted and reported as none. */
int labels_get(uint8_t n, uint8_t l, uint8_t *buf, int cap);

/* Store a validated record, or delete it when len is 0. 0 ok; -EINVAL if the
 * record is malformed or n/l out of range; other <0 on a flash error. */
int labels_set(uint8_t n, uint8_t l, const uint8_t *buf, int len);

/* Delete every layer of slot n / of every slot (profile reset, reset all). */
int labels_clear_slot(uint8_t n);
int labels_clear_all(void);

#endif /* LABELS_H */
