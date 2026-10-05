#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "label_rec.h"

/* Build a record from (ctrl, text) pairs. */
static int build(uint8_t *r, const int *ctrl, const char *const *text, int n)
{
    int o = 0;
    r[o++] = LABEL_REC_VERSION;
    for (int i = 0; i < n; i++) {
        int l = (int)strlen(text[i]);
        r[o++] = (uint8_t)ctrl[i];
        r[o++] = (uint8_t)l;
        memcpy(r + o, text[i], (size_t)l);
        o += l;
    }
    return o;
}

static void t_valid_records(void)
{
    uint8_t r[LABEL_REC_MAX];
    int c1[] = {1};
    const char *s1[] = {"Sustain CC64 ch7"};
    assert(label_rec_valid(r, build(r, c1, s1, 1)));
    int c2[] = {0, 4, 12};
    const char *s2[] = {"Mod", "unassigned", "RWD"};
    assert(label_rec_valid(r, build(r, c2, s2, 3)));
}

/* The largest record: all 13 controls at 24 bytes is exactly LABEL_REC_MAX. */
static void t_largest(void)
{
    uint8_t r[LABEL_REC_MAX];
    int c[13];
    const char *s[13];
    for (int i = 0; i < 13; i++) { c[i] = i; s[i] = "abcdefghijklmnopqrstuvwx"; }
    int n = build(r, c, s, 13);
    assert(n == LABEL_REC_MAX && n == 339);
    assert(label_rec_valid(r, n));
}

static void t_invalid_records(void)
{
    uint8_t r[LABEL_REC_MAX + 8];
    int c[] = {3};
    const char *s[] = {"ok"};
    int n = build(r, c, s, 1);
    assert(!label_rec_valid(r, 0));
    assert(!label_rec_valid(r, 1));                     /* version only: no entry */
    r[0] = 2; assert(!label_rec_valid(r, n)); r[0] = 1; /* unknown version */
    assert(!label_rec_valid(r, n - 1));                 /* text cut short */
    assert(!label_rec_valid(r, n + 1));                 /* trailing byte */
    r[1] = 13; assert(!label_rec_valid(r, n)); r[1] = 3; /* no control 13 */
    r[2] = 0; assert(!label_rec_valid(r, n)); r[2] = 2;  /* empty label */
    r[3] = 0x0A; assert(!label_rec_valid(r, n)); r[3] = 'o';   /* newline */
    r[3] = 0x7F; assert(!label_rec_valid(r, n)); r[3] = 'o';   /* DEL */
    assert(label_rec_valid(r, n));
    int cd[] = {5, 5};                                  /* repeated control */
    const char *sd[] = {"a", "b"};
    assert(!label_rec_valid(r, build(r, cd, sd, 2)));
    int co[] = {6, 2};                                  /* out of order */
    assert(!label_rec_valid(r, build(r, co, sd, 2)));
    uint8_t big[2 + 25 + 1] = {1, 0, 25};              /* a 25-byte label */
    memset(big + 3, 'x', 25);
    assert(!label_rec_valid(big, 28));
}

/* UTF-8 is stored opaque: bytes >= 0x80 pass. */
static void t_utf8_opaque(void)
{
    uint8_t r[16] = {1, 4, 3, 0xE2, 0x80, 0xA2};        /* "•" */
    assert(label_rec_valid(r, 6));
}

static void t_b64_round_trip(void)
{
    uint8_t in[LABEL_REC_MAX], back[LABEL_REC_MAX];
    char s[LABEL_B64_MAX + 1];
    for (int len = 0; len <= LABEL_REC_MAX; len++) {
        for (int i = 0; i < len; i++) in[i] = (uint8_t)(i * 37 + len);
        int e = label_b64_encode(in, len, s, (int)sizeof s);
        assert(e == ((len + 2) / 3) * 4);
        assert(label_b64_decode(s, back, (int)sizeof back) == len);
        assert(memcmp(in, back, (size_t)len) == 0);
    }
    assert(label_b64_encode(in, LABEL_REC_MAX, s, LABEL_B64_MAX) == -1);   /* no room for NUL */
}

static void t_b64_known_and_bad(void)
{
    char s[16];
    uint8_t b[16];
    assert(label_b64_encode((const uint8_t *)"Man", 3, s, sizeof s) == 4 && !strcmp(s, "TWFu"));
    assert(label_b64_encode((const uint8_t *)"Ma", 2, s, sizeof s) == 4 && !strcmp(s, "TWE="));
    assert(label_b64_encode((const uint8_t *)"M", 1, s, sizeof s) == 4 && !strcmp(s, "TQ=="));
    assert(label_b64_decode("TWE=", b, sizeof b) == 2 && b[0] == 'M' && b[1] == 'a');
    assert(label_b64_decode("", b, sizeof b) == 0);
    assert(label_b64_decode("TWE", b, sizeof b) == -1);       /* bad length */
    assert(label_b64_decode("TW!u", b, sizeof b) == -1);      /* bad character */
    assert(label_b64_decode("T=Fu", b, sizeof b) == -1);      /* padding in the middle */
    assert(label_b64_decode("TQ==TWFu", b, sizeof b) == -1);  /* padding before the end */
    assert(label_b64_decode("TWFu", b, 2) == -1);             /* out too small */
}

int main(void)
{
    t_valid_records();
    t_largest();
    t_invalid_records();
    t_utf8_opaque();
    t_b64_round_trip();
    t_b64_known_and_bad();
    printf("test_label_rec: OK\n");
    return 0;
}
