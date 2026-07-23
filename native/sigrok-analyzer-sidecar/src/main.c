#define _POSIX_C_SOURCE 200809L

#include "libsigrokdecode/libsigrokdecode.h"
#include "cJSON.h"

#include <glib.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
    SPI_ANN_MISO_DATA = 0,
    SPI_ANN_MOSI_DATA = 1,
    SPI_ANN_WARNING = 4,
};

typedef struct {
    uint64_t start_sample;
    uint64_t end_sample;
    int ann_class;
    char **texts;
    int text_count;
} annotation_item;

typedef struct {
    annotation_item *items;
    size_t count;
    size_t capacity;
} annotation_list;

typedef struct {
    uint64_t start_sample;
    uint64_t end_sample;
    int bin_class;
    uint64_t value;
} binary_item;

typedef struct {
    binary_item *items;
    size_t count;
    size_t capacity;
} binary_list;

typedef struct {
    annotation_list annotations;
    binary_list binaries;
} decode_collector;

typedef struct {
    int mosi;
    int miso;
    int clk;
    int cs;
    int cpol;
    int cpha;
    int word_size;
    int msb_first;
    int cs_active_low;
} spi_settings;

static void fatal(const char *message)
{
    fprintf(stderr, "%s\n", message);
    exit(2);
}

static char *read_stdin(void)
{
    size_t capacity = 8192;
    size_t length = 0;
    char *buffer = malloc(capacity);
    if (!buffer)
        fatal("out of memory while reading request");

    for (;;) {
        if (length == capacity) {
            capacity *= 2;
            char *next = realloc(buffer, capacity);
            if (!next) {
                free(buffer);
                fatal("out of memory while growing request buffer");
            }
            buffer = next;
        }
        size_t read_count = fread(buffer + length, 1, capacity - length, stdin);
        length += read_count;
        if (read_count == 0)
            break;
    }

    char *next = realloc(buffer, length + 1);
    if (next)
        buffer = next;
    buffer[length] = '\0';
    return buffer;
}

static void print_json(cJSON *value)
{
    char *text = cJSON_PrintUnformatted(value);
    if (!text)
        fatal("failed to serialize JSON response");
    fputs(text, stdout);
    fputc('\n', stdout);
    cJSON_free(text);
}

static cJSON *add_array(cJSON *object, const char *key)
{
    cJSON *array = cJSON_CreateArray();
    cJSON_AddItemToObject(object, key, array);
    return array;
}

static void ensure_annotations(annotation_list *list)
{
    if (list->count < list->capacity)
        return;
    size_t next_capacity = list->capacity ? list->capacity * 2 : 128;
    annotation_item *next = realloc(list->items, next_capacity * sizeof(*next));
    if (!next)
        fatal("out of memory while collecting annotations");
    list->items = next;
    list->capacity = next_capacity;
}

static void ensure_binaries(binary_list *list)
{
    if (list->count < list->capacity)
        return;
    size_t next_capacity = list->capacity ? list->capacity * 2 : 64;
    binary_item *next = realloc(list->items, next_capacity * sizeof(*next));
    if (!next)
        fatal("out of memory while collecting binary output");
    list->items = next;
    list->capacity = next_capacity;
}

static void collect_annotation(struct srd_proto_data *pdata, void *user_data)
{
    if (!pdata || !pdata->data)
        return;
    decode_collector *collector = user_data;
    struct srd_proto_data_annotation *annotation = pdata->data;
    ensure_annotations(&collector->annotations);
    annotation_item *item = &collector->annotations.items[collector->annotations.count++];
    memset(item, 0, sizeof(*item));
    item->start_sample = pdata->start_sample;
    item->end_sample = pdata->end_sample;
    item->ann_class = annotation->ann_class;

    while (annotation->ann_text && annotation->ann_text[item->text_count])
        item->text_count++;
    if (item->text_count == 0)
        return;
    item->texts = calloc((size_t)item->text_count, sizeof(*item->texts));
    if (!item->texts)
        fatal("out of memory while copying annotation text");
    for (int index = 0; index < item->text_count; index++)
        item->texts[index] = strdup(annotation->ann_text[index]);
}

static void collect_binary(struct srd_proto_data *pdata, void *user_data)
{
    if (!pdata || !pdata->data)
        return;
    decode_collector *collector = user_data;
    struct srd_proto_data_binary *binary = pdata->data;
    if (binary->size == 0 || binary->size > sizeof(uint64_t))
        return;
    ensure_binaries(&collector->binaries);
    binary_item *item = &collector->binaries.items[collector->binaries.count++];
    item->start_sample = pdata->start_sample;
    item->end_sample = pdata->end_sample;
    item->bin_class = binary->bin_class;
    item->value = 0;
    for (uint64_t index = 0; index < binary->size; index++)
        item->value = (item->value << 8) | binary->data[index];
}

static void free_collector(decode_collector *collector)
{
    for (size_t index = 0; index < collector->annotations.count; index++) {
        annotation_item *item = &collector->annotations.items[index];
        for (int text_index = 0; text_index < item->text_count; text_index++)
            free(item->texts[text_index]);
        free(item->texts);
    }
    free(collector->annotations.items);
    free(collector->binaries.items);
}

static int json_int(cJSON *object, const char *key, int fallback)
{
    cJSON *value = cJSON_GetObjectItem(object, key);
    return cJSON_IsNumber(value) ? value->valueint : fallback;
}

static const char *json_string(cJSON *object, const char *key, const char *fallback)
{
    cJSON *value = cJSON_GetObjectItem(object, key);
    return cJSON_IsString(value) ? value->valuestring : fallback;
}

static int optional_channel(cJSON *channels, const char *key)
{
    cJSON *value = cJSON_GetObjectItem(channels, key);
    return cJSON_IsNumber(value) ? value->valueint : -1;
}

static void parse_settings(cJSON *request, spi_settings *settings)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    cJSON *channels = decoder ? cJSON_GetObjectItem(decoder, "channels") : NULL;
    cJSON *options = decoder ? cJSON_GetObjectItem(decoder, "options") : NULL;
    if (!decoder || !channels || !options)
        fatal("decoder channels/options are required");

    settings->mosi = optional_channel(channels, "mosi");
    settings->miso = optional_channel(channels, "miso");
    settings->clk = optional_channel(channels, "clk");
    settings->cs = optional_channel(channels, "cs");
    settings->cpol = json_int(options, "cpol", 0);
    settings->cpha = json_int(options, "cpha", 0);
    settings->word_size = json_int(options, "word_size", 8);
    settings->msb_first = strcmp(json_string(options, "bit_order", "msb_first"), "lsb_first") != 0;
    settings->cs_active_low = strcmp(json_string(options, "cs_polarity", "active_low"), "active_high") != 0;
    if (settings->clk < 0 || (settings->mosi < 0 && settings->miso < 0))
        fatal("SPI requires clock and at least one data channel");
}

typedef struct {
    uint8_t initial_level;
    uint64_t *transitions;
    size_t transition_count;
} sparse_channel;

typedef struct {
    int channel_count;
    uint64_t sample_count;
    sparse_channel *channels;
} sparse_input;

static sparse_input build_sparse_input(cJSON *request, int channel_count, uint64_t sample_count)
{
    cJSON *initial_levels = cJSON_GetObjectItem(request, "initial_levels");
    cJSON *edges = cJSON_GetObjectItem(request, "edges");
    if (!cJSON_IsArray(initial_levels) || cJSON_GetArraySize(initial_levels) != channel_count ||
        !cJSON_IsArray(edges))
        fatal("initial_levels and edges arrays are required");

    sparse_input input = {
        .channel_count = channel_count,
        .sample_count = sample_count,
        .channels = calloc((size_t)channel_count, sizeof(*input.channels)),
    };
    if (!input.channels)
        fatal("out of memory while allocating sparse channels");
    for (int channel = 0; channel < channel_count; channel++) {
        cJSON *initial = cJSON_GetArrayItem(initial_levels, channel);
        input.channels[channel].initial_level = cJSON_IsNumber(initial) && initial->valueint ? 1 : 0;
    }

    int edge_set_count = cJSON_GetArraySize(edges);
    for (int set_index = 0; set_index < edge_set_count; set_index++) {
        cJSON *edge_set = cJSON_GetArrayItem(edges, set_index);
        int channel = json_int(edge_set, "channel", -1);
        cJSON *samples = cJSON_GetObjectItem(edge_set, "samples");
        if (channel < 0 || channel >= channel_count || !cJSON_IsArray(samples) ||
            input.channels[channel].transitions)
            fatal("invalid or duplicate sparse edge channel");
        int edge_count = cJSON_GetArraySize(samples);
        if (edge_count > 0) {
            input.channels[channel].transitions = calloc((size_t)edge_count, sizeof(uint64_t));
            if (!input.channels[channel].transitions)
                fatal("out of memory while allocating sparse transitions");
        }
        input.channels[channel].transition_count = (size_t)edge_count;
        uint64_t previous = 0;
        for (int edge_index = 0; edge_index < edge_count; edge_index++) {
            cJSON *edge = cJSON_GetArrayItem(samples, edge_index);
            uint64_t sample = cJSON_IsNumber(edge) ? (uint64_t)edge->valuedouble : 0;
            if (sample == 0 || sample >= sample_count || (edge_index > 0 && sample <= previous))
                fatal("sparse transitions must be strictly increasing and inside the capture");
            input.channels[channel].transitions[edge_index] = sample;
            previous = sample;
        }
    }
    return input;
}

static void free_sparse_input(sparse_input *input)
{
    if (!input || !input->channels)
        return;
    for (int channel = 0; channel < input->channel_count; channel++)
        free(input->channels[channel].transitions);
    free(input->channels);
    memset(input, 0, sizeof(*input));
}

static size_t lower_bound_transition(const sparse_channel *channel, uint64_t sample)
{
    size_t left = 0;
    size_t right = channel->transition_count;
    while (left < right) {
        size_t middle = left + (right - left) / 2;
        if (channel->transitions[middle] < sample)
            left = middle + 1;
        else
            right = middle;
    }
    return left;
}

static uint8_t sparse_level_at(const sparse_channel *channel, uint64_t sample)
{
    size_t index = lower_bound_transition(channel, sample);
    if (index < channel->transition_count && channel->transitions[index] == sample)
        index++;
    return channel->initial_level ^ (uint8_t)(index & 1u);
}

static int physical_channel_for(const struct srd_decoder_inst *di, int decoder_channel)
{
    if (!di || decoder_channel < 0 || decoder_channel >= di->dec_num_channels)
        return -1;
    return di->dec_channelmap[decoder_channel];
}

static int edge_type_matches(const sparse_channel *channel, size_t index, int term_type)
{
    uint8_t before = channel->initial_level ^ (uint8_t)(index & 1u);
    switch (term_type) {
    case SRD_TERM_RISING_EDGE:
        return before == 0;
    case SRD_TERM_FALLING_EDGE:
        return before != 0;
    case SRD_TERM_EITHER_EDGE:
        return 1;
    default:
        return 0;
    }
}

static int next_term_edge(const sparse_input *input, const struct srd_decoder_inst *di,
                          const struct srd_term *term, uint64_t start, uint64_t *sample)
{
    int physical = physical_channel_for(di, term->channel);
    if (physical < 0 || physical >= input->channel_count)
        return 0;
    const sparse_channel *channel = &input->channels[physical];
    size_t index = lower_bound_transition(channel, start);
    while (index < channel->transition_count) {
        if (edge_type_matches(channel, index, term->type)) {
            *sample = channel->transitions[index];
            return 1;
        }
        index++;
    }
    return 0;
}

static int term_matches_at(const sparse_input *input, const struct srd_decoder_inst *di,
                           const struct srd_term *term, uint64_t sample, uint64_t cursor)
{
    if (term->type == SRD_TERM_SKIP)
        return sample >= cursor + term->num_samples_to_skip;
    int physical = physical_channel_for(di, term->channel);
    if (physical < 0 || physical >= input->channel_count)
        return 0;
    const sparse_channel *channel = &input->channels[physical];
    if (term->type == SRD_TERM_HIGH)
        return sparse_level_at(channel, sample) != 0;
    if (term->type == SRD_TERM_LOW)
        return sparse_level_at(channel, sample) == 0;
    size_t index = lower_bound_transition(channel, sample);
    int changed = index < channel->transition_count && channel->transitions[index] == sample;
    if (term->type == SRD_TERM_NO_EDGE)
        return !changed;
    return changed && edge_type_matches(channel, index, term->type);
}

static int group_candidate(const sparse_input *input, const struct srd_decoder_inst *di,
                           const GSList *terms, uint64_t cursor, uint64_t *candidate)
{
    uint64_t value = cursor;
    for (const GSList *item = terms; item; item = item->next) {
        const struct srd_term *term = item->data;
        if (term->type == SRD_TERM_SKIP) {
            uint64_t skipped = cursor + term->num_samples_to_skip;
            if (skipped > value)
                value = skipped;
        } else if (term->type == SRD_TERM_RISING_EDGE ||
                   term->type == SRD_TERM_FALLING_EDGE ||
                   term->type == SRD_TERM_EITHER_EDGE) {
            uint64_t edge = 0;
            if (!next_term_edge(input, di, term, value, &edge))
                return 0;
            if (edge > value)
                value = edge;
        }
    }
    if (value >= input->sample_count)
        return 0;
    for (const GSList *item = terms; item; item = item->next) {
        if (!term_matches_at(input, di, item->data, value, cursor))
            return 0;
    }
    *candidate = value;
    return 1;
}

static void free_condition_list(GSList *conditions)
{
    for (GSList *item = conditions; item; item = item->next)
        g_slist_free_full(item->data, g_free);
    g_slist_free(conditions);
}

static void update_sparse_pin_cache(struct srd_decoder_inst *di, const sparse_input *input,
                                    uint64_t sample)
{
    if (!di->c_pin_cache)
        di->c_pin_cache = g_malloc0((gsize)di->dec_num_channels);
    for (int role = 0; role < di->dec_num_channels; role++) {
        int physical = physical_channel_for(di, role);
        di->c_pin_cache[role] = physical >= 0 && physical < input->channel_count
                                    ? sparse_level_at(&input->channels[physical], sample)
                                    : 0xFF;
    }
    di->c_pin_cache_samplenum = sample;
}

static int sparse_wait(struct srd_decoder_inst *di, GSList *condition_list,
                       uint64_t *samplenum, uint64_t *matched)
{
    const sparse_input *input = (const sparse_input *)di->inbuf_const;
    if (!input)
        return SRD_ERR_ARG;
    free_condition_list(di->condition_list);
    di->condition_list = condition_list;

    if (!condition_list) {
        di->abs_cur_samplenum = 0;
        di->match_array = 0;
        di->abs_cur_matched = FALSE;
        di->first_pos = FALSE;
        update_sparse_pin_cache(di, input, 0);
        if (samplenum)
            *samplenum = 0;
        if (matched)
            *matched = 0;
        return SRD_OK;
    }

    if (di->abs_cur_matched && di->abs_cur_samplenum == UINT64_MAX)
        return SRD_ERR_TERM_REQ;
    uint64_t cursor = di->abs_cur_samplenum + (di->abs_cur_matched ? 1 : 0);
    uint64_t next = UINT64_MAX;
    uint64_t match_bits = 0;
    size_t group_index = 0;
    for (const GSList *group = condition_list; group; group = group->next, group_index++) {
        uint64_t candidate = 0;
        if (!group_candidate(input, di, group->data, cursor, &candidate))
            continue;
        if (candidate < next) {
            next = candidate;
            match_bits = group_index < 64 ? (1ULL << group_index) : 0;
        } else if (candidate == next && group_index < 64) {
            match_bits |= 1ULL << group_index;
        }
    }
    if (next == UINT64_MAX)
        return SRD_ERR_TERM_REQ;

    di->abs_cur_samplenum = next;
    di->match_array = match_bits;
    di->abs_cur_matched = TRUE;
    di->first_pos = FALSE;
    update_sparse_pin_cache(di, input, next);
    if (samplenum)
        *samplenum = next;
    if (matched)
        *matched = match_bits;
    return SRD_OK;
}

static uint8_t sparse_get_pin(struct srd_decoder_inst *di, int channel, uint64_t sample)
{
    const sparse_input *input = (const sparse_input *)di->inbuf_const;
    int physical = physical_channel_for(di, channel);
    if (!input || physical < 0 || physical >= input->channel_count)
        return 0xFF;
    return sparse_level_at(&input->channels[physical], sample);
}

static void *sparse_get_private(struct srd_decoder_inst *di)
{
    return di->user_data;
}

static void sparse_set_private(struct srd_decoder_inst *di, void *data)
{
    di->user_data = data;
}

static const struct srd_decoder_runtime sparse_runtime = {
    .wait = sparse_wait,
    .get_pin = sparse_get_pin,
    .get_private = sparse_get_private,
    .set_private = sparse_set_private,
};

static void add_option_string(GHashTable *options, const char *key, const char *value)
{
    g_hash_table_insert(options, g_strdup(key), g_variant_ref_sink(g_variant_new_string(value)));
}

static void add_option_u64(GHashTable *options, const char *key, uint64_t value)
{
    g_hash_table_insert(options, g_strdup(key), g_variant_ref_sink(g_variant_new_uint64(value)));
}

static void add_channel(GHashTable *channels, const char *role, int channel)
{
    if (channel >= 0)
        g_hash_table_insert(channels, g_strdup(role), g_variant_ref_sink(g_variant_new_int32(channel)));
}

static const char *annotation_text_for(const decode_collector *collector, int ann_class,
                                       uint64_t start_sample, uint64_t end_sample)
{
    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (item->ann_class == ann_class && item->start_sample == start_sample &&
            item->end_sample == end_sample && item->text_count > 0)
            return item->texts[0];
    }
    return NULL;
}

static cJSON *field_value_unsigned(uint64_t value)
{
    cJSON *tagged = cJSON_CreateObject();
    cJSON_AddNumberToObject(tagged, "Unsigned", (double)value);
    return tagged;
}

static void add_word_value(cJSON *fields, cJSON *channel_values, cJSON *texts,
                           const char *name, const char *role, int channel,
                           uint64_t value, const char *annotation_text, int word_size)
{
    cJSON *field = cJSON_CreateObject();
    cJSON_AddStringToObject(field, "name", name);
    cJSON_AddItemToObject(field, "value", field_value_unsigned(value));
    cJSON_AddItemToArray(fields, field);

    int width = (word_size + 3) / 4;
    if (width < 2)
        width = 2;
    char label[40];
    snprintf(label, sizeof(label), "0x%0*llX", width, (unsigned long long)value);
    cJSON_AddItemToArray(texts, cJSON_CreateString(annotation_text ? annotation_text : label));

    cJSON *channel_value = cJSON_CreateObject();
    cJSON_AddNumberToObject(channel_value, "channel", channel);
    cJSON_AddStringToObject(channel_value, "role", role);
    cJSON_AddStringToObject(channel_value, "label", label);
    cJSON_AddNumberToObject(channel_value, "value", (double)value);
    cJSON_AddItemToArray(channel_values, channel_value);
}

static cJSON *render_output(const decode_collector *collector, const spi_settings *settings)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "backend", "sigrok_native");
    cJSON_AddStringToObject(root, "protocol", "SPI");
    cJSON *frames = add_array(root, "frames");

    uint64_t frame_id = 0;
    for (size_t index = 0; index < collector->binaries.count; index++) {
        const binary_item *seed = &collector->binaries.items[index];
        if (seed->bin_class != 0 && seed->bin_class != 1)
            continue;
        int already_rendered = 0;
        for (size_t previous = 0; previous < index; previous++) {
            const binary_item *candidate = &collector->binaries.items[previous];
            if (candidate->start_sample == seed->start_sample && candidate->end_sample == seed->end_sample) {
                already_rendered = 1;
                break;
            }
        }
        if (already_rendered)
            continue;

        const binary_item *miso = NULL;
        const binary_item *mosi = NULL;
        for (size_t pair = index; pair < collector->binaries.count; pair++) {
            const binary_item *candidate = &collector->binaries.items[pair];
            if (candidate->start_sample != seed->start_sample || candidate->end_sample != seed->end_sample)
                continue;
            if (candidate->bin_class == 0)
                miso = candidate;
            else if (candidate->bin_class == 1)
                mosi = candidate;
        }

        cJSON *frame = cJSON_CreateObject();
        cJSON_AddNumberToObject(frame, "frame_id", (double)frame_id++);
        cJSON_AddNumberToObject(frame, "start_sample", (double)seed->start_sample);
        cJSON_AddNumberToObject(frame, "end_sample", (double)seed->end_sample);
        cJSON_AddStringToObject(frame, "row", "result");
        cJSON *texts = add_array(frame, "texts");
        cJSON *fields = add_array(frame, "fields");
        cJSON *channel_values = add_array(frame, "channel_values");
        add_array(frame, "markers");

        if (mosi && settings->mosi >= 0) {
            const char *text = annotation_text_for(collector, SPI_ANN_MOSI_DATA,
                                                   mosi->start_sample, mosi->end_sample);
            add_word_value(fields, channel_values, texts, "mosi", "MOSI", settings->mosi,
                           mosi->value, text, settings->word_size);
        }
        if (miso && settings->miso >= 0) {
            const char *text = annotation_text_for(collector, SPI_ANN_MISO_DATA,
                                                   miso->start_sample, miso->end_sample);
            add_word_value(fields, channel_values, texts, "miso", "MISO", settings->miso,
                           miso->value, text, settings->word_size);
        }
        cJSON_AddItemToArray(frames, frame);
    }

    cJSON *diagnostics = add_array(root, "diagnostics");
    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (item->ann_class != SPI_ANN_WARNING || item->text_count == 0)
            continue;
        cJSON *diagnostic = cJSON_CreateObject();
        cJSON_AddStringToObject(diagnostic, "level", "warning");
        cJSON_AddStringToObject(diagnostic, "message", item->texts[0]);
        cJSON_AddItemToArray(diagnostics, diagnostic);
    }
    return root;
}

static struct srd_decoder *initialize_decoder(const char *decoder_root)
{
    if (srd_init(NULL) != SRD_OK)
        return NULL;
    srd_c_decoder_paths_clear();
    if (decoder_root && *decoder_root)
        srd_c_decoder_path_add(decoder_root);
    srd_c_decoder_load_all();
    return srd_decoder_get_by_id("spi_c");
}

static cJSON *decode_request(cJSON *request, const char *decoder_root)
{
    int channel_count = json_int(request, "channel_count", 0);
    cJSON *sample_count_json = cJSON_GetObjectItem(request, "sample_count");
    cJSON *sample_rate_json = cJSON_GetObjectItem(request, "sample_rate_hz");
    uint64_t sample_count = cJSON_IsNumber(sample_count_json) ? (uint64_t)sample_count_json->valuedouble : 0;
    uint64_t sample_rate = cJSON_IsNumber(sample_rate_json) ? (uint64_t)sample_rate_json->valuedouble : 0;
    if (channel_count <= 0 || channel_count > 32 || sample_count == 0 || sample_rate == 0)
        fatal("invalid channel_count, sample_count, or sample_rate_hz");

    spi_settings settings;
    parse_settings(request, &settings);
    sparse_input input = build_sparse_input(request, channel_count, sample_count);

    struct srd_decoder *decoder = initialize_decoder(decoder_root);
    if (!decoder)
        fatal("PXView spi_c decoder is not available");

    struct srd_session *session = NULL;
    if (srd_session_new(&session) != SRD_OK || !session)
        fatal("failed to create libsigrokdecode session");

    GHashTable *options = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                (GDestroyNotify)g_variant_unref);
    add_option_string(options, "cs_polarity", settings.cs_active_low ? "active-low" : "active-high");
    add_option_u64(options, "cpol", (uint64_t)settings.cpol);
    add_option_u64(options, "cpha", (uint64_t)settings.cpha);
    add_option_string(options, "bitorder", settings.msb_first ? "msb-first" : "lsb-first");
    add_option_u64(options, "wordsize", (uint64_t)settings.word_size);
    add_option_string(options, "format", "hex");
    add_option_string(options, "show_data_point", "no");
    struct srd_decoder_inst *instance = srd_inst_new(session, "spi_c", options);
    g_hash_table_destroy(options);
    if (!instance)
        fatal("failed to create PXView spi_c instance");

    GHashTable *channels = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                 (GDestroyNotify)g_variant_unref);
    add_channel(channels, "clk", settings.clk);
    add_channel(channels, "miso", settings.miso);
    add_channel(channels, "mosi", settings.mosi);
    add_channel(channels, "cs", settings.cs);
    srd_inst_channel_set_all(instance, channels);
    g_hash_table_destroy(channels);
    instance->runtime = &sparse_runtime;
    instance->inbuf_const = (const uint8_t *)&input;
    instance->abs_end_samplenum = sample_count - 1;

    decode_collector collector;
    memset(&collector, 0, sizeof(collector));
    srd_pd_output_callback_add(session, SRD_OUTPUT_ANN, collect_annotation, &collector);
    srd_pd_output_callback_add(session, SRD_OUTPUT_BINARY, collect_binary, &collector);
    srd_session_metadata_set(session, SRD_CONF_SAMPLERATE, g_variant_new_uint64(sample_rate));

    char *error = NULL;
    if (srd_session_start(session, &error) != SRD_OK)
        fatal(error ? error : "failed to start libsigrokdecode session");
    instance->c_dec_inst->decode(instance);
    srd_session_end(session, &error);

    cJSON *output = render_output(&collector, &settings);
    srd_session_destroy(session);
    srd_exit();
    free_sparse_input(&input);
    free_collector(&collector);
    return output;
}

static cJSON *probe(const char *decoder_root)
{
    struct srd_decoder *decoder = initialize_decoder(decoder_root);
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "available", decoder != NULL);
    cJSON *protocols = add_array(root, "protocols");
    if (decoder)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("SPI"));
    cJSON_AddBoolToObject(root, "supports_streaming", 0);
    cJSON_AddStringToObject(root, "decoder_name", decoder && decoder->name ? decoder->name : "PXView SPI(C)");
    cJSON_AddStringToObject(root, "decoder_id", decoder && decoder->id ? decoder->id : "spi_c");
    cJSON_AddNumberToObject(root, "api_version", SRD_C_DECODER_API_VERSION);
    srd_exit();
    return root;
}

int main(int argc, char **argv)
{
    const char *decoder_root = NULL;
    int should_probe = 0;
    int should_decode = 0;
    for (int index = 1; index < argc; index++) {
        if (strcmp(argv[index], "--decoder-root") == 0 && index + 1 < argc)
            decoder_root = argv[++index];
        else if (strcmp(argv[index], "--probe") == 0)
            should_probe = 1;
        else if (strcmp(argv[index], "--decode") == 0)
            should_decode = 1;
    }

    if (should_probe) {
        cJSON *response = probe(decoder_root);
        print_json(response);
        cJSON_Delete(response);
        return 0;
    }
    if (!should_decode)
        fatal("usage: pxlogic-sigrok-sidecar --decoder-root PATH (--probe|--decode)");

    char *input = read_stdin();
    cJSON *request = cJSON_Parse(input);
    free(input);
    if (!request)
        fatal("invalid JSON request");
    cJSON *response = decode_request(request, decoder_root);
    print_json(response);
    cJSON_Delete(response);
    cJSON_Delete(request);
    return 0;
}
