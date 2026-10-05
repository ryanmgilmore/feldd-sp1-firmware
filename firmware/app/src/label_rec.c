/* label_rec.c — see label_rec.h. Pure C, no Zephyr. */
#include "label_rec.h"
#include <string.h>

int label_rec_valid(const uint8_t *r, int len)
{
    if (r == 0 || len < 4 || len > LABEL_REC_MAX || r[0] != LABEL_REC_VERSION) {
        return 0;
    }
    int i = 1, prev = -1, entries = 0;
    while (i < len) {
        if (i + 2 > len) {
            return 0;                       /* a header cut short */
        }
        int ctrl = r[i], n = r[i + 1];
        if (ctrl >= LABEL_CONTROLS || ctrl <= prev) {
            return 0;                       /* unknown, repeated or out of order */
        }
        if (n < 1 || n > LABEL_TEXT_MAX || i + 2 + n > len) {
            return 0;
        }
        for (int k = 0; k < n; k++) {
            uint8_t c = r[i + 2 + k];
            if (c < 0x20 || c == 0x7F) {
                return 0;                   /* control characters never belong in a label */
            }
        }
        prev = ctrl;
        entries++;
        i += 2 + n;
    }
    return entries > 0 && i == len;
}

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int label_b64_encode(const uint8_t *in, int len, char *out, int cap)
{
    int need = ((len + 2) / 3) * 4;
    if (len < 0 || cap < need + 1) {
        return -1;
    }
    int o = 0;
    for (int i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i + 1 < len) v |= (uint32_t)in[i + 1] << 8;
        if (i + 2 < len) v |= in[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = (i + 1 < len) ? B64[(v >> 6) & 63] : '=';
        out[o++] = (i + 2 < len) ? B64[v & 63] : '=';
    }
    out[o] = '\0';
    return o;
}

static int b64_val(char c)
{
    const char *p = (c != '\0') ? strchr(B64, c) : 0;
    return p ? (int)(p - B64) : -1;
}

int label_b64_decode(const char *in, uint8_t *out, int cap)
{
    int len = (int)strlen(in);
    if (len % 4 != 0) {
        return -1;
    }
    int o = 0;
    for (int i = 0; i < len; i += 4) {
        int a = b64_val(in[i]), b = b64_val(in[i + 1]);
        int pad2 = in[i + 2] == '=', pad3 = in[i + 3] == '=';
        int c = pad2 ? 0 : b64_val(in[i + 2]);
        int d = pad3 ? 0 : b64_val(in[i + 3]);
        if (a < 0 || b < 0 || c < 0 || d < 0 || (pad2 && !pad3)) {
            return -1;
        }
        if ((pad2 || pad3) && i + 4 != len) {
            return -1;                      /* padding only at the very end */
        }
        uint32_t v = ((uint32_t)a << 18) | ((uint32_t)b << 12) | ((uint32_t)c << 6) | (uint32_t)d;
        int n = pad2 ? 1 : (pad3 ? 2 : 3);
        if (o + n > cap) {
            return -1;
        }
        out[o++] = (uint8_t)(v >> 16);
        if (n > 1) out[o++] = (uint8_t)(v >> 8);
        if (n > 2) out[o++] = (uint8_t)v;
    }
    return o;
}
