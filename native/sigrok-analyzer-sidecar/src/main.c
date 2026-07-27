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
    char *decoder_id;
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
    uint64_t size;
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

typedef struct {
    int rx;
    int tx;
    uint64_t baudrate;
    int data_bits;
    double stop_bits;
    const char *parity;
    const char *bit_order;
    const char *format;
    int invert_rx;
    int invert_tx;
} uart_settings;

typedef struct {
    int scl;
    int sda;
    const char *address_format;
    const char *packets_format;
    int show_data_point;
} i2c_settings;

typedef struct {
    int sck;
    int ws;
    int sd;
    int word_size;
    int msb_first;
    int left_high;
    int rising_edge;
    const char *bit_shift;
    const char *bit_align;
} i2s_settings;

typedef struct {
    int can_rx;
    uint64_t nominal_bitrate;
    uint64_t fast_bitrate;
    double sample_point;
    int inverted;
} can_settings;

typedef struct {
    int rx;
    uint64_t baudrate;
    int version;
} lin_settings;

#define PARALLEL_DATA_CHANNELS 32

typedef struct {
    int clk;
    int data[PARALLEL_DATA_CHANNELS];
    int max_data_index;
    const char *clock_edge;
    int wordsize;
    const char *endianness;
} parallel_settings;

typedef enum {
    DECODER_SPI,
    DECODER_UART,
    DECODER_I2C,
    DECODER_I2S,
    DECODER_CAN,
    DECODER_CAN_FD,
    DECODER_LIN,
    DECODER_PARALLEL,
} decoder_protocol;

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

static void add_optional_string(cJSON *object, const char *key, const char *value)
{
    if (value)
        cJSON_AddStringToObject(object, key, value);
    else
        cJSON_AddNullToObject(object, key);
}

static void add_gslist_strings(cJSON *object, const char *key, const GSList *list)
{
    cJSON *array = add_array(object, key);
    for (const GSList *item = list; item; item = item->next)
        cJSON_AddItemToArray(array, cJSON_CreateString(item->data ? (const char *)item->data : ""));
}

static int strv_length(char **values)
{
    int length = 0;
    while (values && values[length])
        length++;
    return length;
}

static cJSON *variant_to_json(GVariant *variant)
{
    if (!variant)
        return cJSON_CreateNull();
    if (g_variant_is_of_type(variant, G_VARIANT_TYPE_STRING))
        return cJSON_CreateString(g_variant_get_string(variant, NULL));
    if (g_variant_is_of_type(variant, G_VARIANT_TYPE_BOOLEAN))
        return cJSON_CreateBool(g_variant_get_boolean(variant));
    if (g_variant_is_of_type(variant, G_VARIANT_TYPE_INT64))
        return cJSON_CreateNumber((double)g_variant_get_int64(variant));
    if (g_variant_is_of_type(variant, G_VARIANT_TYPE_UINT64))
        return cJSON_CreateNumber((double)g_variant_get_uint64(variant));
    if (g_variant_is_of_type(variant, G_VARIANT_TYPE_INT32))
        return cJSON_CreateNumber(g_variant_get_int32(variant));
    if (g_variant_is_of_type(variant, G_VARIANT_TYPE_UINT32))
        return cJSON_CreateNumber(g_variant_get_uint32(variant));
    if (g_variant_is_of_type(variant, G_VARIANT_TYPE_DOUBLE))
        return cJSON_CreateNumber(g_variant_get_double(variant));

    gchar *printed = g_variant_print(variant, TRUE);
    cJSON *json = cJSON_CreateString(printed ? printed : "");
    g_free(printed);
    return json;
}

static const char *channel_type_name(int type)
{
    switch (type) {
    case SRD_CHANNEL_SCLK:
        return "clock";
    case SRD_CHANNEL_SDATA:
        return "serial_data";
    case SRD_CHANNEL_ADATA:
        return "analog_data";
    case SRD_CHANNEL_COMMON:
    default:
        return "common";
    }
}

static int is_verified_sparse_c_decoder(const char *decoder_id)
{
    static const char *ids[] = {
        "uart_c", "i2c_c", "spi_c", "i2s_c",
        "can_c", "can_fd_c", "lin_c", "parallel_c",
    };
    for (size_t index = 0; index < sizeof(ids) / sizeof(ids[0]); index++) {
        if (strcmp(decoder_id, ids[index]) == 0)
            return 1;
    }
    return 0;
}

static int load_c_decoder_module(const char *decoder_root, const char *decoder_id)
{
    if (!decoder_root || !*decoder_root || !decoder_id || !*decoder_id)
        return SRD_ERR_ARG;

    char *filenames[2];
#ifdef _WIN32
    filenames[0] = g_strdup_printf("%s.dll", decoder_id);
    filenames[1] = g_strdup_printf("lib%s.dll", decoder_id);
#else
    filenames[0] = g_strdup_printf("lib%s.so", decoder_id);
    filenames[1] = g_strdup_printf("%s.so", decoder_id);
#endif
    int result = SRD_ERR;
    for (size_t index = 0; index < sizeof(filenames) / sizeof(filenames[0]); index++) {
        char *path = g_build_filename(decoder_root, filenames[index], NULL);
        char *absolute = g_canonicalize_filename(path, NULL);
        if (g_file_test(absolute, G_FILE_TEST_IS_REGULAR) &&
            srd_c_decoder_load(absolute) == SRD_OK) {
            result = SRD_OK;
            g_free(absolute);
            g_free(path);
            break;
        }
        g_free(absolute);
        g_free(path);
    }
    for (size_t index = 0; index < sizeof(filenames) / sizeof(filenames[0]); index++)
        g_free(filenames[index]);
    return result;
}

static void load_verified_c_decoders(const char *decoder_root)
{
    static const char *ids[] = {
        "uart_c", "i2c_c", "spi_c", "i2s_c",
        "can_c", "can_fd_c", "lin_c", "parallel_c",
    };
    for (size_t index = 0; index < sizeof(ids) / sizeof(ids[0]); index++)
        load_c_decoder_module(decoder_root, ids[index]);
}

static void add_channel_catalog(cJSON *array, const GSList *channels)
{
    for (const GSList *item = channels; item; item = item->next) {
        const struct srd_channel *channel = item->data;
        if (!channel)
            continue;
        cJSON *entry = cJSON_CreateObject();
        add_optional_string(entry, "id", channel->id);
        add_optional_string(entry, "name", channel->name);
        add_optional_string(entry, "desc", channel->desc);
        cJSON_AddNumberToObject(entry, "order", channel->order);
        cJSON_AddNumberToObject(entry, "type", channel->type);
        cJSON_AddStringToObject(entry, "type_name", channel_type_name(channel->type));
        add_optional_string(entry, "idn", channel->idn);
        cJSON_AddItemToArray(array, entry);
    }
}

static void add_option_catalog(cJSON *array, const GSList *options)
{
    for (const GSList *item = options; item; item = item->next) {
        const struct srd_decoder_option *option = item->data;
        if (!option)
            continue;
        cJSON *entry = cJSON_CreateObject();
        add_optional_string(entry, "id", option->id);
        add_optional_string(entry, "idn", option->idn);
        add_optional_string(entry, "desc", option->desc);
        cJSON_AddStringToObject(entry, "value_type",
                                option->def ? g_variant_get_type_string(option->def) : "unknown");
        cJSON_AddItemToObject(entry, "default", variant_to_json(option->def));
        cJSON *values = add_array(entry, "values");
        for (const GSList *value = option->values; value; value = value->next)
            cJSON_AddItemToArray(values, variant_to_json(value->data));
        cJSON_AddItemToArray(array, entry);
    }
}

static void add_annotation_catalog(cJSON *array, const GSList *annotations, const GSList *ann_types)
{
    int ann_class = 0;
    const GSList *type_item = ann_types;
    for (const GSList *item = annotations; item; item = item->next, ann_class++) {
        char **parts = item->data;
        int part_count = strv_length(parts);
        int ann_type = type_item ? GPOINTER_TO_INT(type_item->data) : ann_class;
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddNumberToObject(entry, "class", ann_class);
        cJSON_AddNumberToObject(entry, "type", ann_type);
        if (part_count >= 3) {
            add_optional_string(entry, "id", parts[1]);
            add_optional_string(entry, "desc", parts[2]);
        } else {
            add_optional_string(entry, "id", part_count > 0 ? parts[0] : NULL);
            add_optional_string(entry, "desc", part_count > 1 ? parts[1] : NULL);
        }
        cJSON *labels = add_array(entry, "labels");
        for (int index = 0; index < part_count; index++)
            cJSON_AddItemToArray(labels, cJSON_CreateString(parts[index] ? parts[index] : ""));
        cJSON_AddItemToArray(array, entry);
        if (type_item)
            type_item = type_item->next;
    }
}

static void add_annotation_row_catalog(cJSON *array, const GSList *rows)
{
    for (const GSList *item = rows; item; item = item->next) {
        const struct srd_decoder_annotation_row *row = item->data;
        if (!row)
            continue;
        cJSON *entry = cJSON_CreateObject();
        add_optional_string(entry, "id", row->id);
        add_optional_string(entry, "desc", row->desc);
        cJSON *classes = add_array(entry, "ann_classes");
        for (const GSList *ann_class = row->ann_classes; ann_class; ann_class = ann_class->next)
            cJSON_AddItemToArray(classes, cJSON_CreateNumber(GPOINTER_TO_SIZE(ann_class->data)));
        cJSON_AddItemToArray(array, entry);
    }
}

static void add_pair_catalog(cJSON *array, const GSList *pairs)
{
    int pair_class = 0;
    for (const GSList *item = pairs; item; item = item->next, pair_class++) {
        char **parts = item->data;
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddNumberToObject(entry, "class", pair_class);
        add_optional_string(entry, "id", parts && parts[0] ? parts[0] : NULL);
        add_optional_string(entry, "desc", parts && parts[1] ? parts[1] : NULL);
        cJSON_AddItemToArray(array, entry);
    }
}

static void add_decoder_catalog_item(cJSON *array, const struct srd_decoder *decoder)
{
    cJSON *entry = cJSON_CreateObject();
    add_optional_string(entry, "id", decoder->id);
    add_optional_string(entry, "name", decoder->name);
    add_optional_string(entry, "longname", decoder->longname);
    add_optional_string(entry, "desc", decoder->desc);
    add_optional_string(entry, "license", decoder->license);
    cJSON_AddStringToObject(entry, "kind", decoder->is_c_decoder ? "c" : "python");
    cJSON_AddStringToObject(entry, "runner_status",
                            decoder->is_c_decoder && is_verified_sparse_c_decoder(decoder->id)
                                ? "verified_sparse_c"
                                : "catalog_only");
    add_gslist_strings(entry, "inputs", decoder->inputs);
    add_gslist_strings(entry, "outputs", decoder->outputs);
    add_gslist_strings(entry, "tags", decoder->tags);
    cJSON *channels = add_array(entry, "channels");
    add_channel_catalog(channels, decoder->channels);
    cJSON *optional_channels = add_array(entry, "optional_channels");
    add_channel_catalog(optional_channels, decoder->opt_channels);
    cJSON *options = add_array(entry, "options");
    add_option_catalog(options, decoder->options);
    cJSON *annotations = add_array(entry, "annotations");
    add_annotation_catalog(annotations, decoder->annotations, decoder->ann_types);
    cJSON *annotation_rows = add_array(entry, "annotation_rows");
    add_annotation_row_catalog(annotation_rows, decoder->annotation_rows);
    cJSON *binary = add_array(entry, "binary");
    add_pair_catalog(binary, decoder->binary);
    cJSON_AddItemToArray(array, entry);
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
    item->decoder_id = strdup(
        pdata->pdo && pdata->pdo->di && pdata->pdo->di->decoder ? pdata->pdo->di->decoder->id : "");
    if (!item->decoder_id)
        fatal("out of memory while copying annotation decoder id");

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
    item->size = binary->size;
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
        free(item->decoder_id);
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

static double json_double(cJSON *object, const char *key, double fallback)
{
    cJSON *value = cJSON_GetObjectItem(object, key);
    return cJSON_IsNumber(value) ? value->valuedouble : fallback;
}

static int optional_channel(cJSON *channels, const char *key)
{
    cJSON *value = cJSON_GetObjectItem(channels, key);
    return cJSON_IsNumber(value) ? value->valueint : -1;
}

static decoder_protocol parse_protocol(cJSON *request)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    const char *protocol = decoder ? json_string(decoder, "protocol", "") : "";
    if (strcmp(protocol, "uart") == 0)
        return DECODER_UART;
    if (strcmp(protocol, "i2c") == 0)
        return DECODER_I2C;
    if (strcmp(protocol, "spi") == 0)
        return DECODER_SPI;
    if (strcmp(protocol, "i2s") == 0)
        return DECODER_I2S;
    if (strcmp(protocol, "can") == 0)
        return DECODER_CAN;
    if (strcmp(protocol, "can_fd") == 0 || strcmp(protocol, "can-fd") == 0)
        return DECODER_CAN_FD;
    if (strcmp(protocol, "lin") == 0)
        return DECODER_LIN;
    if (strcmp(protocol, "parallel") == 0 || strcmp(protocol, "simple_parallel") == 0)
        return DECODER_PARALLEL;
    fatal("decoder.protocol must be one of uart, i2c, spi, i2s, can, can_fd, lin, or parallel");
    return DECODER_SPI;
}

static void parse_spi_settings(cJSON *request, spi_settings *settings)
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

static void parse_uart_settings(cJSON *request, uart_settings *settings)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    cJSON *channels = decoder ? cJSON_GetObjectItem(decoder, "channels") : NULL;
    cJSON *options = decoder ? cJSON_GetObjectItem(decoder, "options") : NULL;
    if (!decoder || !channels || !options)
        fatal("decoder channels/options are required");

    settings->rx = optional_channel(channels, "rx");
    settings->tx = optional_channel(channels, "tx");
    settings->baudrate = (uint64_t)json_int(options, "baudrate", 115200);
    settings->data_bits = json_int(options, "data_bits", 8);
    settings->stop_bits = cJSON_IsNumber(cJSON_GetObjectItem(options, "stop_bits"))
                              ? cJSON_GetObjectItem(options, "stop_bits")->valuedouble
                              : 1.0;
    settings->parity = json_string(options, "parity", "none");
    settings->bit_order = json_string(options, "bit_order", "lsb-first");
    settings->format = json_string(options, "format", "hex");
    settings->invert_rx = json_int(options, "invert_rx", 0) != 0;
    settings->invert_tx = json_int(options, "invert_tx", 0) != 0;
    if (settings->baudrate == 0 || settings->data_bits < 5 || settings->data_bits > 9 ||
        settings->stop_bits < 0.0 || settings->stop_bits > 2.0 ||
        (settings->rx < 0 && settings->tx < 0))
        fatal("invalid UART settings");
}

static void parse_i2c_settings(cJSON *request, i2c_settings *settings)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    cJSON *channels = decoder ? cJSON_GetObjectItem(decoder, "channels") : NULL;
    cJSON *options = decoder ? cJSON_GetObjectItem(decoder, "options") : NULL;
    if (!decoder || !channels || !options)
        fatal("decoder channels/options are required");

    settings->scl = optional_channel(channels, "scl");
    settings->sda = optional_channel(channels, "sda");
    settings->address_format = json_string(options, "address_format", "shifted");
    settings->packets_format = json_string(options, "packets_format", "hex");
    settings->show_data_point = json_int(options, "show_data_point", 1) != 0;
    if (settings->scl < 0 || settings->sda < 0 || settings->scl == settings->sda)
        fatal("I2C requires distinct SCL and SDA channels");
}

static void parse_i2s_settings(cJSON *request, i2s_settings *settings)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    cJSON *channels = decoder ? cJSON_GetObjectItem(decoder, "channels") : NULL;
    cJSON *options = decoder ? cJSON_GetObjectItem(decoder, "options") : NULL;
    if (!decoder || !channels || !options)
        fatal("decoder channels/options are required");

    settings->sck = optional_channel(channels, "sck");
    settings->ws = optional_channel(channels, "ws");
    settings->sd = optional_channel(channels, "sd");
    settings->word_size = json_int(options, "word_size", json_int(options, "wordsize", 16));
    settings->msb_first = strcmp(json_string(options, "bit_order", "msb-first"), "lsb-first") != 0;
    settings->left_high = strcmp(json_string(options, "ws_polarity", "right-high"), "right-high") != 0;
    settings->rising_edge = strcmp(json_string(options, "clk_edge", "rising-edge"), "falling-edge") != 0;
    settings->bit_shift = json_string(options, "bit_shift", "right-shifted by one");
    settings->bit_align = json_string(options, "bit_align", "left-aligned");
    if (settings->sck < 0 || settings->ws < 0 || settings->sd < 0 ||
        settings->sck == settings->ws || settings->sck == settings->sd || settings->ws == settings->sd ||
        settings->word_size < 1 || settings->word_size > 32)
        fatal("I2S requires distinct SCK, WS, and SD channels and a 1-32 bit word size");
}

static void parse_can_settings(cJSON *request, can_settings *settings, int can_fd)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    cJSON *channels = decoder ? cJSON_GetObjectItem(decoder, "channels") : NULL;
    cJSON *options = decoder ? cJSON_GetObjectItem(decoder, "options") : NULL;
    if (!decoder || !channels || !options)
        fatal("decoder channels/options are required");

    settings->can_rx = optional_channel(channels, "can_rx");
    settings->nominal_bitrate = (uint64_t)json_int(
        options, can_fd ? "nominal_bitrate" : "bitrate", 1000000);
    settings->fast_bitrate = (uint64_t)json_int(options, "fast_bitrate", 2000000);
    settings->sample_point = json_double(options, "sample_point", 70.0);
    settings->inverted = json_int(options, "inverted", 0) != 0;
    if (settings->can_rx < 0 || settings->nominal_bitrate == 0 ||
        (can_fd && settings->fast_bitrate == 0) || settings->sample_point <= 0.0 ||
        settings->sample_point >= 100.0)
        fatal("invalid CAN channel, bitrate, or sample point");
}

static void parse_lin_settings(cJSON *request, lin_settings *settings)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    cJSON *channels = decoder ? cJSON_GetObjectItem(decoder, "channels") : NULL;
    cJSON *options = decoder ? cJSON_GetObjectItem(decoder, "options") : NULL;
    if (!decoder || !channels || !options)
        fatal("decoder channels/options are required");

    settings->rx = optional_channel(channels, "rx");
    if (settings->rx < 0)
        settings->rx = optional_channel(channels, "channel");
    settings->baudrate = (uint64_t)json_int(options, "baudrate", json_int(options, "bit_rate", 19200));
    settings->version = json_int(options, "version", 2);
    if (settings->rx < 0 || settings->baudrate == 0 ||
        (settings->version != 1 && settings->version != 2))
        fatal("LIN requires an input channel, a positive bit rate, and version 1 or 2");
}

static void parse_parallel_settings(cJSON *request, parallel_settings *settings)
{
    cJSON *decoder = cJSON_GetObjectItem(request, "decoder");
    cJSON *channels = decoder ? cJSON_GetObjectItem(decoder, "channels") : NULL;
    cJSON *options = decoder ? cJSON_GetObjectItem(decoder, "options") : NULL;
    if (!decoder || !channels || !options)
        fatal("decoder channels/options are required");

    settings->clk = optional_channel(channels, "clk");
    if (settings->clk < 0)
        settings->clk = optional_channel(channels, "clock");
    settings->max_data_index = -1;
    for (int index = 0; index < PARALLEL_DATA_CHANNELS; index++) {
        char key[8];
        snprintf(key, sizeof(key), "d%d", index);
        settings->data[index] = optional_channel(channels, key);
        if (settings->data[index] >= 0)
            settings->max_data_index = index;
    }
    const char *edge = json_string(options, "clock_edge", "rising");
    settings->clock_edge = (strcmp(edge, "falling") == 0 || strcmp(edge, "falling-edge") == 0)
                               ? "falling"
                               : "rising";
    settings->wordsize = 0;
    settings->endianness = "little";

    if (settings->clk < 0 || settings->max_data_index < 0)
        fatal("Simple Parallel requires Clock and at least one data channel");
    for (int index = 0; index <= settings->max_data_index; index++) {
        if (settings->data[index] < 0)
            continue;
        if (settings->data[index] == settings->clk)
            fatal("Simple Parallel Clock and data channels must be distinct");
        for (int previous = 0; previous < index; previous++) {
            if (settings->data[previous] == settings->data[index])
                fatal("Simple Parallel data channels must be distinct");
        }
    }
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

static void add_option_i64(GHashTable *options, const char *key, int64_t value)
{
    g_hash_table_insert(options, g_strdup(key), g_variant_ref_sink(g_variant_new_int64(value)));
}

static void add_option_double(GHashTable *options, const char *key, double value)
{
    g_hash_table_insert(options, g_strdup(key), g_variant_ref_sink(g_variant_new_double(value)));
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

static const char *annotation_text_overlapping(const decode_collector *collector, int ann_class,
                                               uint64_t start_sample, uint64_t end_sample)
{
    const char *best = NULL;
    uint64_t best_span = 0;
    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (item->ann_class != ann_class || item->text_count == 0)
            continue;
        if (item->start_sample <= end_sample && item->end_sample >= start_sample) {
            uint64_t span = item->end_sample >= item->start_sample
                                ? item->end_sample - item->start_sample
                                : 0;
            if (!best || span > best_span) {
                best = item->texts[0];
                best_span = span;
            }
        }
    }
    return best;
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

static void add_protocol_value(cJSON *frame, const char *name, const char *role, int channel,
                               uint64_t value, const char *text, int width)
{
    cJSON *fields = cJSON_GetObjectItem(frame, "fields");
    cJSON *channel_values = cJSON_GetObjectItem(frame, "channel_values");
    cJSON *texts = cJSON_GetObjectItem(frame, "texts");
    cJSON *field = cJSON_CreateObject();
    cJSON_AddStringToObject(field, "name", name);
    cJSON_AddItemToObject(field, "value", field_value_unsigned(value));
    cJSON_AddItemToArray(fields, field);

    char label[40];
    snprintf(label, sizeof(label), "0x%0*llX", width < 2 ? 2 : width,
             (unsigned long long)value);
    cJSON_AddItemToArray(texts, cJSON_CreateString(text ? text : label));

    if (channel >= 0) {
        cJSON *channel_value = cJSON_CreateObject();
        cJSON_AddNumberToObject(channel_value, "channel", channel);
        cJSON_AddStringToObject(channel_value, "role", role);
        cJSON_AddStringToObject(channel_value, "label", label);
        cJSON_AddNumberToObject(channel_value, "value", (double)value);
        cJSON_AddItemToArray(channel_values, channel_value);
    }
}

static cJSON *new_frame(uint64_t frame_id, uint64_t start_sample, uint64_t end_sample,
                        const char *row)
{
    cJSON *frame = cJSON_CreateObject();
    cJSON_AddNumberToObject(frame, "frame_id", (double)frame_id);
    cJSON_AddNumberToObject(frame, "start_sample", (double)start_sample);
    cJSON_AddNumberToObject(frame, "end_sample", (double)end_sample);
    cJSON_AddStringToObject(frame, "row", row);
    add_array(frame, "texts");
    add_array(frame, "fields");
    add_array(frame, "channel_values");
    add_array(frame, "markers");
    return frame;
}

static int parse_parallel_annotation_value(const char *text, uint64_t *value)
{
    if (!text || !*text)
        return 0;
    if (text[0] == '@') {
        char *end = NULL;
        unsigned long long parsed = strtoull(text + 1, &end, 16);
        if (end && *end == '\0') {
            *value = (uint64_t)parsed;
            return 1;
        }
        return 0;
    }
    if (strlen(text) == 4 && text[0] == '\\' && text[1] == 'x') {
        char *end = NULL;
        unsigned long long parsed = strtoull(text + 2, &end, 16);
        if (end && *end == '\0') {
            *value = (uint64_t)parsed;
            return 1;
        }
    }
    if (strlen(text) == 2 && text[0] == '\\') {
        switch (text[1]) {
        case '0': *value = 0; return 1;
        case 'a': *value = '\a'; return 1;
        case 'b': *value = '\b'; return 1;
        case 't': *value = '\t'; return 1;
        case 'n': *value = '\n'; return 1;
        case 'v': *value = '\v'; return 1;
        case 'f': *value = '\f'; return 1;
        case 'r': *value = '\r'; return 1;
        default: break;
        }
    }
    if (strlen(text) == 1) {
        *value = (unsigned char)text[0];
        return 1;
    }
    return 0;
}

static int parallel_primary_channel(const parallel_settings *settings)
{
    for (int index = 0; index <= settings->max_data_index; index++) {
        if (settings->data[index] >= 0)
            return settings->data[index];
    }
    return -1;
}

static cJSON *render_parallel_output(const decode_collector *collector,
                                     const parallel_settings *settings)
{
    enum { PARALLEL_ANN_ITEMS = 0, PARALLEL_ANN_WORDS = 1 };
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "backend", "sigrok_native");
    cJSON_AddStringToObject(root, "protocol", "Simple Parallel");
    cJSON *frames = add_array(root, "frames");
    uint64_t frame_id = 0;
    const int primary_channel = parallel_primary_channel(settings);
    const int data_bits = settings->max_data_index + 1;

    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if ((item->ann_class != PARALLEL_ANN_ITEMS && item->ann_class != PARALLEL_ANN_WORDS) ||
            item->text_count == 0) {
            continue;
        }
        uint64_t value = 0;
        const char *text = item->texts[0];
        if (!parse_parallel_annotation_value(text, &value))
            continue;
        const int width_bits = item->ann_class == PARALLEL_ANN_WORDS && settings->wordsize > 0
                                   ? data_bits * settings->wordsize
                                   : data_bits;
        cJSON *frame = new_frame(frame_id++, item->start_sample, item->end_sample,
                                 item->ann_class == PARALLEL_ANN_WORDS ? "Words" : "Items");
        add_protocol_value(frame,
                           item->ann_class == PARALLEL_ANN_WORDS ? "word" : "data",
                           "Data", primary_channel, value, text, (width_bits + 3) / 4);
        cJSON_AddItemToArray(frames, frame);
    }

    add_array(root, "diagnostics");
    return root;
}

static cJSON *render_uart_output(const decode_collector *collector, const uart_settings *settings)
{
    enum { UART_RX_DATA = 2, UART_TX_DATA = 3, UART_RX_WARN = 0, UART_TX_WARN = 1 };
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "backend", "sigrok_native");
    cJSON_AddStringToObject(root, "protocol", "UART");
    cJSON *frames = add_array(root, "frames");
    uint64_t frame_id = 0;

    for (size_t index = 0; index < collector->binaries.count; index++) {
        const binary_item *item = &collector->binaries.items[index];
        if (item->bin_class != 0 && item->bin_class != 1)
            continue;
        int channel = item->bin_class == 0 ? settings->rx : settings->tx;
        int ann_class = item->bin_class == 0 ? UART_RX_DATA : UART_TX_DATA;
        const char *text = annotation_text_overlapping(collector, ann_class,
                                                        item->start_sample, item->end_sample);
        cJSON *frame = new_frame(frame_id++, item->start_sample, item->end_sample,
                                 item->bin_class == 0 ? "RX" : "TX");
        add_protocol_value(frame, "data", item->bin_class == 0 ? "RX" : "TX", channel,
                           item->value, text, (settings->data_bits + 3) / 4);
        cJSON_AddItemToArray(frames, frame);
    }

    cJSON *diagnostics = add_array(root, "diagnostics");
    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if ((item->ann_class == UART_RX_WARN || item->ann_class == UART_TX_WARN) &&
            item->text_count > 0) {
            cJSON *diagnostic = cJSON_CreateObject();
            cJSON_AddStringToObject(diagnostic, "level", "warning");
            cJSON_AddStringToObject(diagnostic, "message", item->texts[0]);
            cJSON_AddItemToArray(diagnostics, diagnostic);
        }
    }
    return root;
}

static cJSON *render_i2c_output(const decode_collector *collector, const i2c_settings *settings)
{
    enum {
        I2C_ADDRESS_READ = 6,
        I2C_ADDRESS_WRITE = 7,
        I2C_DATA_READ = 8,
        I2C_DATA_WRITE = 9,
    };
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "backend", "sigrok_native");
    cJSON_AddStringToObject(root, "protocol", "I2C");
    cJSON *frames = add_array(root, "frames");
    uint64_t frame_id = 0;

    for (size_t index = 0; index < collector->binaries.count; index++) {
        const binary_item *item = &collector->binaries.items[index];
        if (item->bin_class < 0 || item->bin_class > 3)
            continue;
        int ann_class;
        const char *name;
        const char *direction;
        if (item->bin_class == 0) {
            ann_class = I2C_ADDRESS_READ; name = "address"; direction = "Read";
        } else if (item->bin_class == 1) {
            ann_class = I2C_ADDRESS_WRITE; name = "address"; direction = "Write";
        } else if (item->bin_class == 2) {
            ann_class = I2C_DATA_READ; name = "data"; direction = "Read";
        } else {
            ann_class = I2C_DATA_WRITE; name = "data"; direction = "Write";
        }
        const char *text = annotation_text_overlapping(collector, ann_class,
                                                        item->start_sample, item->end_sample);
        char row[32];
        snprintf(row, sizeof(row), "%s %s",
                 strcmp(name, "address") == 0 ? "Address" : "Data",
                 strcmp(direction, "Read") == 0 ? "read" : "write");
        cJSON *frame = new_frame(frame_id++, item->start_sample, item->end_sample, row);
        add_protocol_value(frame, name, direction, settings->sda, item->value, text, 2);
        cJSON_AddItemToArray(frames, frame);
    }
    add_array(root, "diagnostics");
    return root;
}

static cJSON *render_i2s_output(const decode_collector *collector, const i2s_settings *settings)
{
    enum { I2S_LEFT = 0, I2S_RIGHT = 1, I2S_WARNING = 2 };
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "backend", "sigrok_native");
    cJSON_AddStringToObject(root, "protocol", "I2S");
    cJSON *frames = add_array(root, "frames");
    uint64_t frame_id = 0;

    for (size_t index = 0; index < collector->binaries.count; index++) {
        const binary_item *item = &collector->binaries.items[index];
        if (item->bin_class != 0)
            continue;
        const char *left = annotation_text_for(collector, I2S_LEFT,
                                               item->start_sample, item->end_sample);
        const char *right = annotation_text_for(collector, I2S_RIGHT,
                                                item->start_sample, item->end_sample);
        if (!left && !right)
            continue;
        const int is_left = left != NULL;
        uint64_t value = 0;
        for (uint64_t byte = 0; byte < item->size; byte++)
            value |= ((item->value >> ((item->size - byte - 1) * 8)) & 0xffu) << (byte * 8);
        cJSON *frame = new_frame(frame_id++, item->start_sample, item->end_sample,
                                 is_left ? "Left" : "Right");
        add_protocol_value(frame, is_left ? "left" : "right",
                           is_left ? "Left" : "Right", settings->sd, value,
                           is_left ? left : right, (settings->word_size + 3) / 4);
        cJSON_AddItemToArray(frames, frame);
    }

    cJSON *diagnostics = add_array(root, "diagnostics");
    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (item->ann_class != I2S_WARNING || item->text_count == 0)
            continue;
        cJSON *diagnostic = cJSON_CreateObject();
        cJSON_AddStringToObject(diagnostic, "level", "warning");
        cJSON_AddStringToObject(diagnostic, "message", item->texts[0]);
        cJSON_AddItemToArray(diagnostics, diagnostic);
    }
    return root;
}

static int annotation_overlaps_class(const decode_collector *collector, int ann_class,
                                     uint64_t start_sample, uint64_t end_sample)
{
    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (item->ann_class == ann_class && item->start_sample <= end_sample &&
            item->end_sample >= start_sample)
            return 1;
    }
    return 0;
}

static int parse_hex_text(const char *text, uint64_t *value)
{
    const char *hex = text ? strstr(text, "0x") : NULL;
    if (!hex)
        return 0;
    char *end = NULL;
    unsigned long long parsed = strtoull(hex + 2, &end, 16);
    if (end == hex + 2)
        return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static int parse_decimal_text(const char *text, uint64_t *value)
{
    const char *cursor = text ? strchr(text, ':') : NULL;
    cursor = cursor ? cursor + 1 : text;
    while (cursor && *cursor && (*cursor < '0' || *cursor > '9'))
        cursor++;
    if (!cursor || !*cursor)
        return 0;
    char *end = NULL;
    unsigned long long parsed = strtoull(cursor, &end, 10);
    if (end == cursor)
        return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static int parse_hex_after_colon(const char *text, uint64_t *value)
{
    const char *cursor = text ? strchr(text, ':') : NULL;
    cursor = cursor ? cursor + 1 : text;
    while (cursor && *cursor && (*cursor == ' ' || *cursor == '\t'))
        cursor++;
    if (!cursor || !*cursor)
        return 0;
    char *end = NULL;
    unsigned long long parsed = strtoull(cursor, &end, 16);
    if (end == cursor)
        return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static cJSON *field_value_boolean(int value)
{
    cJSON *tagged = cJSON_CreateObject();
    cJSON_AddBoolToObject(tagged, "Boolean", value != 0);
    return tagged;
}

static void add_can_value(cJSON *frame, const char *name, const char *role, int channel,
                          uint64_t value, const char *label, int boolean_value)
{
    cJSON *fields = cJSON_GetObjectItem(frame, "fields");
    cJSON *field = cJSON_CreateObject();
    cJSON_AddStringToObject(field, "name", name);
    cJSON_AddItemToObject(field, "value",
                          boolean_value ? field_value_boolean(value != 0) : field_value_unsigned(value));
    cJSON_AddItemToArray(fields, field);

    cJSON *channel_values = cJSON_GetObjectItem(frame, "channel_values");
    cJSON *channel_value = cJSON_CreateObject();
    cJSON_AddNumberToObject(channel_value, "channel", channel);
    cJSON_AddStringToObject(channel_value, "role", role);
    cJSON_AddStringToObject(channel_value, "label", label);
    cJSON_AddNumberToObject(channel_value, "value", (double)value);
    cJSON_AddItemToArray(channel_values, channel_value);
}

static void add_can_texts(cJSON *frame, const annotation_item *item,
                          const char *short_text, const char *medium_text)
{
    cJSON *texts = cJSON_GetObjectItem(frame, "texts");
    cJSON_AddItemToArray(texts, cJSON_CreateString(short_text));
    if (medium_text && strcmp(medium_text, short_text) != 0)
        cJSON_AddItemToArray(texts, cJSON_CreateString(medium_text));
    for (int text_index = 0; text_index < item->text_count; text_index++) {
        const char *text = item->texts[text_index];
        if (strcmp(text, short_text) != 0 && (!medium_text || strcmp(text, medium_text) != 0))
            cJSON_AddItemToArray(texts, cJSON_CreateString(text));
    }
}

static cJSON *render_can_output(const decode_collector *collector, const can_settings *settings,
                                int can_fd)
{
    enum {
        CAN_ANN_DATA = 0,
        CAN_ANN_ID = 3,
        CAN_ANN_FULL_ID = 5,
        CAN_ANN_DLC = 10,
        CAN_ANN_CRC = 11,
        CAN_ANN_ACK = 13,
        CAN_ANN_WARNING = 16,
    };
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "backend", "sigrok_native");
    cJSON_AddStringToObject(root, "protocol", can_fd ? "CAN-FD" : "CAN");
    cJSON *frames = add_array(root, "frames");
    uint64_t frame_id = 0;

    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (item->text_count == 0)
            continue;
        if (item->ann_class == CAN_ANN_ID &&
            annotation_overlaps_class(collector, CAN_ANN_FULL_ID,
                                      item->start_sample, item->end_sample))
            continue;

        const char *field_name = NULL;
        const char *role = NULL;
        const char *row = NULL;
        uint64_t value = 0;
        int parsed = 0;
        int boolean_value = 0;
        char short_text[40];
        char medium_text[64];

        if (item->ann_class == CAN_ANN_ID || item->ann_class == CAN_ANN_FULL_ID) {
            field_name = "identifier";
            role = "Identifier";
            row = "identifier_field";
            parsed = parse_hex_text(item->texts[0], &value);
            snprintf(short_text, sizeof(short_text), "0x%llX", (unsigned long long)value);
            snprintf(medium_text, sizeof(medium_text), "ID: %s", short_text);
        } else if (item->ann_class == CAN_ANN_DLC) {
            field_name = "num_data_bytes";
            role = "DLC";
            row = "control_field";
            parsed = parse_decimal_text(item->texts[0], &value);
            snprintf(short_text, sizeof(short_text), "%llu", (unsigned long long)value);
            snprintf(medium_text, sizeof(medium_text), "DLC: %s", short_text);
        } else if (item->ann_class == CAN_ANN_DATA) {
            field_name = "data";
            role = "Data";
            row = "data_field";
            parsed = parse_hex_text(item->texts[0], &value);
            snprintf(short_text, sizeof(short_text), "0x%02llX", (unsigned long long)value);
            snprintf(medium_text, sizeof(medium_text), "Data: %s", short_text);
        } else if (item->ann_class == CAN_ANN_CRC && strstr(item->texts[0], "CRC-")) {
            field_name = "crc";
            role = "CRC";
            row = "crc_field";
            parsed = parse_hex_text(item->texts[0], &value);
            snprintf(short_text, sizeof(short_text), "CRC");
            snprintf(medium_text, sizeof(medium_text), "CRC: 0x%04llX", (unsigned long long)value);
        } else if (item->ann_class == CAN_ANN_ACK && strstr(item->texts[0], "ACK slot:")) {
            field_name = "ack";
            role = "ACK";
            row = "ack_field";
            value = strstr(item->texts[0], "NACK") == NULL;
            parsed = 1;
            boolean_value = 1;
            snprintf(short_text, sizeof(short_text), "%s", value ? "ACK" : "NACK");
            snprintf(medium_text, sizeof(medium_text), "%s", short_text);
        }
        if (!parsed)
            continue;

        cJSON *frame = new_frame(frame_id++, item->start_sample, item->end_sample, row);
        add_can_texts(frame, item, short_text, medium_text);
        add_can_value(frame, field_name, role, settings->can_rx, value, short_text, boolean_value);
        cJSON_AddItemToArray(frames, frame);
    }

    cJSON *diagnostics = add_array(root, "diagnostics");
    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (item->ann_class != CAN_ANN_WARNING || item->text_count == 0)
            continue;
        cJSON *diagnostic = cJSON_CreateObject();
        cJSON_AddStringToObject(diagnostic, "level", "warning");
        cJSON_AddStringToObject(diagnostic, "message", item->texts[0]);
        cJSON_AddItemToArray(diagnostics, diagnostic);
    }
    return root;
}

static cJSON *render_lin_output(const decode_collector *collector, const lin_settings *settings)
{
    enum {
        LIN_ANN_DATA = 0,
        LIN_ANN_CONTROL = 1,
        LIN_ANN_ERROR = 2,
        LIN_ANN_INLINE_ERROR = 3,
    };
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "backend", "sigrok_native");
    cJSON_AddStringToObject(root, "protocol", "LIN");
    cJSON *frames = add_array(root, "frames");
    cJSON *diagnostics = add_array(root, "diagnostics");
    uint64_t frame_id = 0;

    for (size_t index = 0; index < collector->annotations.count; index++) {
        const annotation_item *item = &collector->annotations.items[index];
        if (strcmp(item->decoder_id, "lin_c") != 0)
            continue;
        if (item->ann_class == LIN_ANN_ERROR || item->ann_class == LIN_ANN_INLINE_ERROR) {
            if (item->text_count > 0) {
                cJSON *diagnostic = cJSON_CreateObject();
                cJSON_AddStringToObject(diagnostic, "level", "warning");
                cJSON_AddStringToObject(diagnostic, "message", item->texts[0]);
                cJSON_AddItemToArray(diagnostics, diagnostic);
            }
            if (item->ann_class == LIN_ANN_ERROR)
                continue;
        }
        if ((item->ann_class != LIN_ANN_DATA && item->ann_class != LIN_ANN_CONTROL &&
             item->ann_class != LIN_ANN_INLINE_ERROR) || item->text_count == 0)
            continue;

        const char *text = item->texts[0];
        const char *name = NULL;
        const char *role = NULL;
        const char *row = "control_field";
        uint64_t value = 0;
        if (strstr(text, "ID:") != NULL &&
            (parse_hex_text(text, &value) || parse_hex_after_colon(text, &value))) {
            name = "identifier";
            role = "Identifier";
            row = "identifier_field";
        } else if (strstr(text, "Data:") != NULL && parse_hex_text(text, &value)) {
            name = "data";
            role = "Data";
            row = "data_field";
        } else if (strstr(text, "Checksum:") != NULL && parse_hex_text(text, &value)) {
            name = "checksum";
            role = "Checksum";
            row = "checksum_field";
        } else if (strcmp(text, "Sync") == 0) {
            name = "sync";
            role = "Sync";
            value = 0x55;
        } else if (strstr(text, "Break") != NULL) {
            name = "break";
            role = "Break";
        }
        if (!name)
            continue;

        cJSON *frame = new_frame(frame_id++, item->start_sample, item->end_sample, row);
        if (role && strcmp(role, "Break") != 0) {
            char identifier_label[32];
            const char *label = text;
            if (strcmp(role, "Identifier") == 0) {
                snprintf(identifier_label, sizeof(identifier_label), "ID: 0x%02llX",
                         (unsigned long long)value);
                label = identifier_label;
            }
            cJSON *texts = cJSON_GetObjectItem(frame, "texts");
            cJSON_AddItemToArray(texts, cJSON_CreateString(label));
            cJSON *fields = cJSON_GetObjectItem(frame, "fields");
            cJSON *field = cJSON_CreateObject();
            cJSON_AddStringToObject(field, "name", name);
            cJSON_AddItemToObject(field, "value", field_value_unsigned(value));
            cJSON_AddItemToArray(fields, field);
            cJSON *channel_values = cJSON_GetObjectItem(frame, "channel_values");
            cJSON *channel_value = cJSON_CreateObject();
            cJSON_AddNumberToObject(channel_value, "channel", settings->rx);
            cJSON_AddStringToObject(channel_value, "role", "LIN");
            cJSON_AddStringToObject(channel_value, "label", label);
            cJSON_AddNumberToObject(channel_value, "value", (double)value);
            cJSON_AddItemToArray(channel_values, channel_value);
        } else {
            cJSON *texts = cJSON_GetObjectItem(frame, "texts");
            cJSON_AddItemToArray(texts, cJSON_CreateString(text));
            cJSON *fields = cJSON_GetObjectItem(frame, "fields");
            cJSON *field = cJSON_CreateObject();
            cJSON_AddStringToObject(field, "name", name);
            cJSON *tagged = cJSON_CreateObject();
            cJSON_AddStringToObject(tagged, "Text", text);
            cJSON_AddItemToObject(field, "value", tagged);
            cJSON_AddItemToArray(fields, field);
            cJSON *channel_values = cJSON_GetObjectItem(frame, "channel_values");
            cJSON *channel_value = cJSON_CreateObject();
            cJSON_AddNumberToObject(channel_value, "channel", settings->rx);
            cJSON_AddStringToObject(channel_value, "role", "LIN");
            cJSON_AddStringToObject(channel_value, "label", text);
            cJSON_AddNumberToObject(channel_value, "value", 0);
            cJSON_AddItemToArray(channel_values, channel_value);
        }
        cJSON_AddItemToArray(frames, frame);
    }
    return root;
}

static int initialize_sigrok(const char *decoder_root, const char *python_decoder_root,
                             int load_full_catalog)
{
    if (srd_init(python_decoder_root && *python_decoder_root ? python_decoder_root : NULL) != SRD_OK)
        return SRD_ERR;
    srd_c_decoder_paths_clear();
    if (decoder_root && *decoder_root)
        srd_c_decoder_path_add(decoder_root);
    if (load_full_catalog)
        return srd_decoder_load_all();
    load_verified_c_decoders(decoder_root);
    return SRD_OK;
}

static struct srd_decoder *initialize_decoder(const char *decoder_root,
                                              const char *python_decoder_root,
                                              const char *decoder_id)
{
    if (initialize_sigrok(decoder_root, python_decoder_root, 0) != SRD_OK)
        return NULL;
    load_c_decoder_module(decoder_root, decoder_id);
    return srd_decoder_get_by_id(decoder_id);
}

static cJSON *decode_request(cJSON *request, const char *decoder_root,
                             const char *python_decoder_root)
{
    int channel_count = json_int(request, "channel_count", 0);
    cJSON *sample_count_json = cJSON_GetObjectItem(request, "sample_count");
    cJSON *sample_rate_json = cJSON_GetObjectItem(request, "sample_rate_hz");
    uint64_t sample_count = cJSON_IsNumber(sample_count_json) ? (uint64_t)sample_count_json->valuedouble : 0;
    uint64_t sample_rate = cJSON_IsNumber(sample_rate_json) ? (uint64_t)sample_rate_json->valuedouble : 0;
    if (channel_count <= 0 || channel_count > 32 || sample_count == 0 || sample_rate == 0)
        fatal("invalid channel_count, sample_count, or sample_rate_hz");

    decoder_protocol protocol = parse_protocol(request);
    spi_settings spi;
    uart_settings uart;
    i2c_settings i2c;
    i2s_settings i2s;
    can_settings can;
    lin_settings lin;
    parallel_settings parallel;
    memset(&spi, 0, sizeof(spi));
    memset(&uart, 0, sizeof(uart));
    memset(&i2c, 0, sizeof(i2c));
    memset(&i2s, 0, sizeof(i2s));
    memset(&can, 0, sizeof(can));
    memset(&lin, 0, sizeof(lin));
    memset(&parallel, 0, sizeof(parallel));
    const char *decoder_id;
    if (protocol == DECODER_UART) {
        parse_uart_settings(request, &uart);
        decoder_id = "uart_c";
    } else if (protocol == DECODER_I2C) {
        parse_i2c_settings(request, &i2c);
        decoder_id = "i2c_c";
    } else if (protocol == DECODER_I2S) {
        parse_i2s_settings(request, &i2s);
        decoder_id = "i2s_c";
    } else if (protocol == DECODER_CAN) {
        parse_can_settings(request, &can, 0);
        decoder_id = "can_c";
    } else if (protocol == DECODER_CAN_FD) {
        parse_can_settings(request, &can, 1);
        decoder_id = "can_fd_c";
    } else if (protocol == DECODER_LIN) {
        parse_lin_settings(request, &lin);
        decoder_id = "lin_c";
    } else if (protocol == DECODER_PARALLEL) {
        parse_parallel_settings(request, &parallel);
        decoder_id = "parallel_c";
    } else {
        parse_spi_settings(request, &spi);
        decoder_id = "spi_c";
    }
    sparse_input input = build_sparse_input(request, channel_count, sample_count);
    if ((protocol == DECODER_CAN || protocol == DECODER_CAN_FD) && can.inverted)
        input.channels[can.can_rx].initial_level ^= 1u;

    struct srd_decoder *decoder = initialize_decoder(decoder_root, python_decoder_root, decoder_id);
    if (!decoder)
        fatal("requested PXView C decoder is not available");

    struct srd_session *session = NULL;
    if (srd_session_new(&session) != SRD_OK || !session)
        fatal("failed to create libsigrokdecode session");

    GHashTable *options = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                (GDestroyNotify)g_variant_unref);
    if (protocol == DECODER_UART) {
        add_option_i64(options, "baudrate", (int64_t)uart.baudrate);
        add_option_i64(options, "data_bits", (int64_t)uart.data_bits);
        add_option_double(options, "stop_bits", uart.stop_bits);
        add_option_string(options, "parity", uart.parity);
        add_option_string(options, "bit_order", uart.bit_order);
        add_option_string(options, "format", uart.format);
        add_option_string(options, "invert_rx", uart.invert_rx ? "yes" : "no");
        add_option_string(options, "invert_tx", uart.invert_tx ? "yes" : "no");
        add_option_string(options, "show_data_point", "no");
        add_option_string(options, "show_start_stop", "yes");
    } else if (protocol == DECODER_I2C) {
        add_option_string(options, "address_format", i2c.address_format);
        add_option_string(options, "packets_format", i2c.packets_format);
        add_option_string(options, "show_data_point", i2c.show_data_point ? "yes" : "no");
    } else if (protocol == DECODER_I2S) {
        add_option_string(options, "ws_polarity", i2s.left_high ? "left-high" : "right-high");
        add_option_string(options, "clk_edge", i2s.rising_edge ? "rising-edge" : "falling-edge");
        add_option_string(options, "bit_shift", i2s.bit_shift);
        add_option_string(options, "bit_align", i2s.bit_align);
        add_option_string(options, "bitorder", i2s.msb_first ? "msb-first" : "lsb-first");
        add_option_u64(options, "wordsize", (uint64_t)i2s.word_size);
    } else if (protocol == DECODER_CAN) {
        add_option_i64(options, "bitrate", (int64_t)can.nominal_bitrate);
        add_option_double(options, "sample_point", can.sample_point);
    } else if (protocol == DECODER_CAN_FD) {
        add_option_i64(options, "nominal_bitrate", (int64_t)can.nominal_bitrate);
        add_option_i64(options, "fast_bitrate", (int64_t)can.fast_bitrate);
        add_option_double(options, "sample_point", can.sample_point);
    } else if (protocol == DECODER_LIN) {
        add_option_i64(options, "version", lin.version);
    } else if (protocol == DECODER_PARALLEL) {
        add_option_string(options, "clock_edge", parallel.clock_edge);
        add_option_i64(options, "wordsize", parallel.wordsize);
        add_option_string(options, "endianness", parallel.endianness);
    } else {
        add_option_string(options, "cs_polarity", spi.cs_active_low ? "active-low" : "active-high");
        add_option_u64(options, "cpol", (uint64_t)spi.cpol);
        add_option_u64(options, "cpha", (uint64_t)spi.cpha);
        add_option_string(options, "bitorder", spi.msb_first ? "msb-first" : "lsb-first");
        add_option_u64(options, "wordsize", (uint64_t)spi.word_size);
        add_option_string(options, "format", "hex");
        add_option_string(options, "show_data_point", "no");
    }
    struct srd_decoder_inst *instance = srd_inst_new(session, decoder_id, options);
    g_hash_table_destroy(options);
    if (!instance)
        fatal("failed to create PXView C decoder instance");

    GHashTable *channels = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                 (GDestroyNotify)g_variant_unref);
    if (protocol == DECODER_UART) {
        add_channel(channels, "rx", uart.rx);
        add_channel(channels, "tx", uart.tx);
    } else if (protocol == DECODER_I2C) {
        add_channel(channels, "scl", i2c.scl);
        add_channel(channels, "sda", i2c.sda);
    } else if (protocol == DECODER_I2S) {
        add_channel(channels, "sck", i2s.sck);
        add_channel(channels, "ws", i2s.ws);
        add_channel(channels, "sd", i2s.sd);
    } else if (protocol == DECODER_CAN || protocol == DECODER_CAN_FD) {
        add_channel(channels, "can_rx", can.can_rx);
    } else if (protocol == DECODER_LIN) {
        /* LIN consumes UART protocol output, so its source instance gets the physical RX map below. */
    } else if (protocol == DECODER_PARALLEL) {
        add_channel(channels, "clk", parallel.clk);
        for (int index = 0; index <= parallel.max_data_index; index++) {
            char role[8];
            snprintf(role, sizeof(role), "d%d", index);
            add_channel(channels, role, parallel.data[index]);
        }
    } else {
        add_channel(channels, "clk", spi.clk);
        add_channel(channels, "miso", spi.miso);
        add_channel(channels, "mosi", spi.mosi);
        add_channel(channels, "cs", spi.cs);
    }
    srd_inst_channel_set_all(instance, channels);
    g_hash_table_destroy(channels);
    struct srd_decoder_inst *source_instance = instance;
    if (protocol == DECODER_LIN) {
        GHashTable *uart_options = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                         (GDestroyNotify)g_variant_unref);
        add_option_i64(uart_options, "baudrate", (int64_t)lin.baudrate);
        add_option_i64(uart_options, "data_bits", 8);
        add_option_double(uart_options, "stop_bits", 1.0);
        add_option_string(uart_options, "parity", "none");
        add_option_string(uart_options, "bit_order", "lsb-first");
        add_option_string(uart_options, "format", "hex");
        add_option_string(uart_options, "invert_rx", "no");
        add_option_string(uart_options, "invert_tx", "no");
        add_option_string(uart_options, "show_data_point", "no");
        add_option_string(uart_options, "show_start_stop", "yes");
        source_instance = srd_inst_new(session, "uart_c", uart_options);
        g_hash_table_destroy(uart_options);
        if (!source_instance)
            fatal("failed to create LIN UART source decoder");
        GHashTable *uart_channels = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                          (GDestroyNotify)g_variant_unref);
        add_channel(uart_channels, "rx", lin.rx);
        srd_inst_channel_set_all(source_instance, uart_channels);
        g_hash_table_destroy(uart_channels);
        if (srd_inst_stack(session, source_instance, instance) != SRD_OK)
            fatal("failed to stack LIN decoder on UART source");
    }
    source_instance->runtime = &sparse_runtime;
    source_instance->inbuf_const = (const uint8_t *)&input;
    source_instance->abs_end_samplenum = sample_count - 1;

    decode_collector collector;
    memset(&collector, 0, sizeof(collector));
    srd_pd_output_callback_add(session, SRD_OUTPUT_ANN, collect_annotation, &collector);
    srd_pd_output_callback_add(session, SRD_OUTPUT_BINARY, collect_binary, &collector);
    srd_session_metadata_set(session, SRD_CONF_SAMPLERATE, g_variant_new_uint64(sample_rate));

    char *error = NULL;
    if (srd_session_start(session, &error) != SRD_OK)
        fatal(error ? error : "failed to start libsigrokdecode session");
    source_instance->c_dec_inst->decode(source_instance);
    srd_session_end(session, &error);

    cJSON *output = protocol == DECODER_UART
                        ? render_uart_output(&collector, &uart)
                        : protocol == DECODER_I2C
                              ? render_i2c_output(&collector, &i2c)
                              : protocol == DECODER_I2S
                                    ? render_i2s_output(&collector, &i2s)
                                    : protocol == DECODER_CAN
                                          ? render_can_output(&collector, &can, 0)
                                          : protocol == DECODER_CAN_FD
                                                ? render_can_output(&collector, &can, 1)
                                                : protocol == DECODER_LIN
                                                      ? render_lin_output(&collector, &lin)
                                                : protocol == DECODER_PARALLEL
                                                      ? render_parallel_output(&collector, &parallel)
                                                      : render_output(&collector, &spi);
    srd_session_destroy(session);
    srd_exit();
    free_sparse_input(&input);
    free_collector(&collector);
    return output;
}

static cJSON *probe(const char *decoder_root, const char *python_decoder_root, int include_catalog)
{
    if (initialize_sigrok(decoder_root, python_decoder_root, include_catalog) != SRD_OK)
        fatal("failed to initialize libsigrokdecode decoder catalog");
    struct srd_decoder *uart = srd_decoder_get_by_id("uart_c");
    struct srd_decoder *i2c = srd_decoder_get_by_id("i2c_c");
    struct srd_decoder *spi = srd_decoder_get_by_id("spi_c");
    struct srd_decoder *i2s = srd_decoder_get_by_id("i2s_c");
    struct srd_decoder *can = srd_decoder_get_by_id("can_c");
    struct srd_decoder *can_fd = srd_decoder_get_by_id("can_fd_c");
    struct srd_decoder *lin = srd_decoder_get_by_id("lin_c");
    struct srd_decoder *parallel = srd_decoder_get_by_id("parallel_c");
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "available",
                          uart != NULL || i2c != NULL || spi != NULL || i2s != NULL ||
                              can != NULL || can_fd != NULL || lin != NULL || parallel != NULL);
    cJSON *protocols = add_array(root, "protocols");
    if (uart)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("UART"));
    if (i2c)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("I2C"));
    if (spi)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("SPI"));
    if (i2s)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("I2S"));
    if (can)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("CAN"));
    if (can_fd)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("CAN-FD"));
    if (lin)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("LIN"));
    if (parallel)
        cJSON_AddItemToArray(protocols, cJSON_CreateString("Parallel"));
    cJSON_AddBoolToObject(root, "supports_streaming", 0);
    cJSON_AddStringToObject(root, "decoder_name", "PXView native C decoder pack");
    cJSON_AddStringToObject(root, "decoder_id", "uart_c,i2c_c,spi_c,i2s_c,can_c,can_fd_c,lin_c,parallel_c");
    cJSON_AddNumberToObject(root, "api_version", SRD_C_DECODER_API_VERSION);
    add_optional_string(root, "decoder_root", decoder_root);
    add_optional_string(root, "python_decoder_root", python_decoder_root);
    cJSON_AddBoolToObject(root, "catalog_included", include_catalog);
    int c_decoder_count = 0;
    int python_decoder_count = 0;
    cJSON *catalog = include_catalog ? add_array(root, "decoder_catalog") : NULL;
    for (const GSList *item = srd_decoder_list(); item; item = item->next) {
        const struct srd_decoder *decoder = item->data;
        if (!decoder)
            continue;
        if (decoder->is_c_decoder)
            c_decoder_count++;
        else
            python_decoder_count++;
        if (catalog)
            add_decoder_catalog_item(catalog, decoder);
    }
    if (!catalog)
        add_array(root, "decoder_catalog");
    cJSON_AddNumberToObject(root, "c_decoder_count", c_decoder_count);
    cJSON_AddNumberToObject(root, "python_decoder_count", python_decoder_count);
    srd_exit();
    return root;
}

int main(int argc, char **argv)
{
    const char *decoder_root = NULL;
    const char *python_decoder_root = NULL;
    int should_probe = 0;
    int should_decode = 0;
    int include_catalog = 0;
    for (int index = 1; index < argc; index++) {
        if (strcmp(argv[index], "--decoder-root") == 0 && index + 1 < argc)
            decoder_root = argv[++index];
        else if (strcmp(argv[index], "--python-decoder-root") == 0 && index + 1 < argc)
            python_decoder_root = argv[++index];
        else if (strcmp(argv[index], "--catalog") == 0)
            include_catalog = 1;
        else if (strcmp(argv[index], "--probe") == 0)
            should_probe = 1;
        else if (strcmp(argv[index], "--decode") == 0)
            should_decode = 1;
    }

    if (should_probe) {
        cJSON *response = probe(decoder_root, python_decoder_root, include_catalog);
        print_json(response);
        cJSON_Delete(response);
        return 0;
    }
    if (!should_decode)
        fatal("usage: pxlogic-sigrok-sidecar --decoder-root PATH [--python-decoder-root PATH] (--probe|--decode)");

    char *input = read_stdin();
    cJSON *request = cJSON_Parse(input);
    free(input);
    if (!request)
        fatal("invalid JSON request");
    cJSON *response = decode_request(request, decoder_root, python_decoder_root);
    print_json(response);
    cJSON_Delete(response);
    cJSON_Delete(request);
    return 0;
}
