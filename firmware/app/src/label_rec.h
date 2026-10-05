#ifndef LABEL_REC_H
#define LABEL_REC_H
#include <stdint.h>

/* label_rec.h — one layer's control labels as the SP-1 stores them (pure; host
 * tested by firmware/test/test_label_rec.c). The format is sp1dev's
 * labels/SPEC.md §1, shared byte for byte with the configurator:
 *
 *   [0]     format version, 1
 *   then    ctrl (0..12, strictly increasing) · len (1..24) · len bytes of text
 *
 * ctrl is the configurator's control index: F1 F2 F3 F4 Play T1 T2 T3 T4 Vol+
 * Vol- FWD RWD = 0..12. Text is UTF-8, no byte below 0x20, no 0x7F; the firmware
 * never interprets it beyond that check. A layer without labels has no record. */

#define LABEL_REC_VERSION   1
#define LABEL_CONTROLS      13
#define LABEL_TEXT_MAX      24
#define LABEL_REC_MAX       (1 + LABEL_CONTROLS * (2 + LABEL_TEXT_MAX))   /* 339 */
#define LABEL_B64_MAX       (((LABEL_REC_MAX + 2) / 3) * 4)               /* 452 */

/* 1 if r[0..len) is a well-formed record (at least one entry), else 0. */
int label_rec_valid(const uint8_t *r, int len);

/* Standard base64 with '=' padding. encode: chars written (NUL added), -1 if
 * out cannot hold them. decode: bytes written, -1 on a bad character, a bad
 * length, or out too small. An empty string decodes to 0 bytes. */
int label_b64_encode(const uint8_t *in, int len, char *out, int cap);
int label_b64_decode(const char *in, uint8_t *out, int cap);

#endif /* LABEL_REC_H */
