import pickle
import struct
import sys
import pandas as pd
from io import BytesIO
import numpy as np
import os
import sqlite3

SCHEMA = {
    "machine": {
        "GUID": bytearray,
        "deleted": bool,
        "Company": str,
        "name": str,
        "serialnumber": str,
    },
    "run": {
        "ID": (int, "PRIMARY KEY"),
        "machine": bytearray,
        "name": str,
        "date": pd.Timestamp,
        "softwareVersion": str,
        "processed": int,
        "calFactor": np.float64,
        "fringeSize": np.float64,
        "deleted": bool,
        "LastUpdate": pd.Timestamp,
        "library_run": int,
        "set_run": int,
        "OperatorName": str,
        "RunTimeDate": str,
        "OperatorNotes": str,
    },
    "run_summary": {
        "runId": (int, "REFERENCES run(ID)"),
        "machine_type": str,
        "run_Mode": str,
        "priming_Method": str,
        "flow_Rate": str,
        "recalibrations": str,
        "stop_Reason": str,
        "sample_Volume_Aspirated": np.float64,
        "sample_Volume_Processed": np.float64,
        "fluid_Volume_Imaged": np.float64,
        "efficiency": "percentage",
        "particle_Count": np.float64,
        "Images": np.float64,
        "images_Used": np.float64,
        "images_Percentage_Used": np.float64,
        "particles_Per_Used_Image": np.float64,
        "particles_Per_Image": np.float64,
        "particles_Removed_By_Capture_Filter": np.float64,
        "frameRate": np.float64,
        "intensity_Mean": np.float64,
        "intensity_Min": np.float64,
        "intensity_Max": np.float64,
        "start": pd.Timestamp,
        "end": pd.Timestamp,
        "sampling_Time": pd.Timedelta,
        "environment": str,
        "magnification": str,
        "calibration_Factor": np.float64,
        "board_Info": str,
        "serial_No": np.float64,
        "number_of_Processors": np.float64,
        "pump_Type": str,
        "syringe_Size": np.float64,
        "calibration_fluid_volume": np.float64,
        "acceptable_right": np.float64,
        "acceptable_left": np.float64,
        "acceptable_top": np.float64,
        "acceptable_bottom": np.float64,
        "StandardVolumeCorrection": np.float64,
        "calibrationFactorPPML": np.float64,
        "autoImageRate": np.float64,
        "manualFluidVol": np.float64,
        "fringeSize": np.float64,
        "flowCellDepth": np.float64,
        "flowCellWidth": np.float64,
        "runTimeMS": np.float64,
        "usingSyringePump": np.float64,
        "useDeadVol": np.float64,
        "deadVolTubeLength": np.float64,
        "deadVolTubeDiam": np.float64,
        "calFluidNonSample": np.float64,
        "useDilution": np.float64,
        "sampleDilution": np.float64,
        "Notes": str,
    },
    "context_history": {
        "run_id": (int, "REFERENCES run(ID)"),
        "context_history_id": (int, "PRIMARY KEY"),
        "software_name": str,
        "software_version": str,
        "software_beta_flag": int,
        "camera_mag": int,
        "firmware_ver": str,
        "serial_no": int,
        "technician_name": str,
        "location_name": str,
        "location_latitude": np.float64,
        "location_longitude": np.float64,
        "run_start_time": pd.Timestamp,
        "run_end_time": pd.Timestamp,
        "time_zone": str,
        "autoimage_rate": np.float64,
        "flash_duration": np.float64,
        "flash_amplitude": np.float64,
        "flash_delay": np.float64,
        "recovery_time": np.float64,
        "laser_cycle_time": np.float64,
        "camera_trigger_duration": np.float64,
        "pvdbrbc": np.float64,
        "pvdbrbe": np.float64,
        "ch1_measure": np.float64,
        "ch1_trigger": np.float64,
        "ch1_threshold": np.float64,
        "ch1_high_threshold": np.float64,
        "ch2_measure": np.float64,
        "ch2_trigger": np.float64,
        "ch2_threshold": np.float64,
        "ch2_high_threshold": np.float64,
        "qdac_pmt_sensitivity1": np.float64,
        "qdac_pmt_sensitivity2": np.float64,
        "qdac_laser_power": np.float64,
        "qdac_flash_amplitude": np.float64,
        "scatter_measure": np.float64,
        "scatter_trigger": np.float64,
        "scatter_threshold": np.float64,
        "pmt_sample_width": np.float64,
        "gum_long_average_duration_us": np.float64,
        "gum_short_average_duration_us": np.float64,
        "min_trigger_pulse_width": np.float64,
        "scatter_detector": bool,
        "use_log_scale": bool,
        "skip_multi_particle_images": bool,
        "pmt_gain": np.float64,
        "small_particle_filter": bool,
        "laser_enabled": bool,
        "auto_trigger_flag": bool,
        "camera_name": str,
        "initialization": str,
        "shutter": np.float64,
        "gain": np.float64,
        "white_balance_u": np.float64,
        "white_balance_v": np.float64,
        "brightness": np.float64,
        "gamma": np.float64,
        "hue": np.float64,
        "saturation": np.float64,
        "sharpness": np.float64,
        "red_gain": np.float64,
        "green_gain": np.float64,
        "blue_gain": np.float64,
        "color_gain": np.float64,
        "auto_adjust_intensity": np.float64,
        "auto_intensity_target": np.float64,
        "auto_intensity_shutter_min": np.float64,
        "auto_intensity_shutter_max": np.float64,
        "auto_intensity_gain_min": np.float64,
        "auto_intensity_gain_max": np.float64,
        "auto_intensity_brightness_min": np.float64,
        "auto_intensity_brightness_max": np.float64,
        "auto_intensity_flashduration_min": np.float64,
        "auto_intensity_flashduration_max": np.float64,
        "auto_adjust_white_balance": np.float64,
        "image_width": np.float64,
        "image_height": np.float64,
        "bayer_red": np.float64,
        "bayer_green": np.float64,
        "bayer_blue": np.float64,
        "max_particles": np.float64,
        "stop_on_max_particles": bool,
        "max_run_time_minutes": np.float64,
        "max_run_time_seconds": np.float64,
        "stop_on_max_runtime": np.float64,
        "max_image_files": np.float64,
        "stop_on_max_image_files": bool,
        "max_camera_images": np.float64,
        "stop_on_max_camera_images": bool,
        "max_fluid_volume": np.float64,
        "stop_on_fluid_volume": bool,
        "stop_on_user_only": bool,
        "calibration_factor_ppml": np.float64,
        "standard_volume_correction": np.float64,
        "recalibration_interval_minutes": np.float64,
        "auto_export_list": bool,
        "auto_export_list_summary": bool,
        "auto_print_summary": bool,
        "auto_classify": bool,
        "auto_export_classification_summary": bool,
        "classification_template": str,
        "classification_template_id": int,
        "flowcell_type": str,
        "flowcell_depth": np.float64,
        "flowcell_width": np.float64,
        "use_manual_volume": bool,
        "manual_volume_ml": np.float64,
        "fluid_volume_imaged_ml": np.float64,
        "use_dead_volume_calculation": bool,
        "dead_volume_tube_length_cm": np.float64,
        "dead_volume_tube_diameter_cm": np.float64,
        "use_dilution_calculation": bool,
        "sample_dilution": np.float64,
        "pump_flow_rate": np.float64,
        "priming_method": str,
        "pump_to_flowcell_tube_length_cm": np.float64,
        "valve_to_cleaner_tube_length_cm": np.float64,
        "pump_error_budget_volume": np.float64,
        "pump_error_budget_multiplier": np.float64,
        "pump_flowcell_length_cm": np.float64,
        "pump_flowcell_fraction": np.float64,
        "calibration_constant": np.float64,
        "fringe_size": np.float64,
        "acceptable_left": np.float64,
        "acceptable_right": np.float64,
        "acceptable_top": np.float64,
        "acceptable_bottom": np.float64,
        "image_pixel_border": np.float64,
        "save_image_files": bool,
        "save_binary_image_files": bool,
        "save_raw_files": bool,
        "max_num_raw_files": np.float64,
        "flat_field_count": np.float64,
        "distance_to_neighbor": np.float64,
        "threshold_dark": np.float64,
        "threshold_light": np.float64,
        "close_holes": np.float64,
        "capture_dark_or_light_pixels": str,
        "min_esd": np.float64,
        "max_esd": np.float64,
        "simple_capture_filter_diameter": str,
        "use_advanced_filter": bool,
        "filter_name": str,
        "use_rolling_cal": bool,
        "rolling_cal_frame_count": np.float64,
        "raw_image_total": np.float64,
        "run_time_milliseconds": np.float64,
        "calibrations_completed_count": np.float64,
        "sample_volume_aspirated": np.float64,
        "calibration_fluid_volume": np.float64,
        "calibration_fluid_volume_non_sample": np.float64,
        "cspump_flow_rate": np.float64,
        "concentration_type": str,
        "particles_per_used_image": np.float64,
        "particles_per_image": np.float64,
        "trigger_count": np.float64,
        "efficiency": np.float64,
        "velocity_crit": np.float64,
        "velocity_ave": np.float64,
        "volume_cf": np.float64,
        "includes_volume_cf": bool,
        "auto_trigger": bool,
        "file_processing": bool,
        "using_syringe_pump": bool,
        "images_run_frame_rate": np.float64,
        "images_run_flow_rate": np.float64,
        "images_run_sample_volume_aspirated": np.float64,
        "images_run_calibration_fluid_volume": np.float64,
        "images_run_calibration_fluid_volume_non_sample": np.float64,
        "count_mode": str,
    },
    "image_frame": {"ID": (int, "PRIMARY KEY"), "run": (int, "REFERENCES run(ID)"), "timestamp": pd.Timestamp, "deleted": bool},
    "particle": {
        "ID": (int, "PRIMARY KEY"),
        "imageFrame": (int, "REFERENCES image_frame(ID)"),
        "deleted": bool,
        "capture_id": int,
        "uuid": bytearray,
    },
    "particle_property": {
        "particle": (int, "REFERENCES particle(ID)"),
        "areaABD": np.float64,
        "areaFilled": np.float64,
        "aspectRatio": np.float64,
        "averageBlue": np.float64,
        "averageGreen": np.float64,
        "averageRed": np.float64,
        "biovolumeCylinder": np.float64,
        "biovolumePSpheroid": np.float64,
        "biovolumeSphere": np.float64,
        "calibrationFactor": np.float64,
        "calibrationImage": np.float64,
        "captureX": np.float64,
        "captureY": np.float64,
        "ch1Area": np.float64,
        "ch1Peak": np.float64,
        "ch1Width": np.float64,
        "ch2Area": np.float64,
        "ch2Peak": np.float64,
        "ch2Width": np.float64,
        "ch2_ch1Ratio": np.float64,
        "circleFit": np.float64,
        "circularityHU": np.float64,
        "circularity": np.float64,
        "compactness": np.float64,
        "convexPerimeter": np.float64,
        "convexity": np.float64,
        "diameterABD": np.float64,
        "diameterESD": np.float64,
        "diameterFD": np.float64,
        "displayID": np.float64,
        "edgeGradient": np.float64,
        "elapsedTime": np.float64,
        "elongation": np.float64,
        "feretAngleMax": np.float64,
        "feretAngleMin": np.float64,
        "fiberCurl": np.float64,
        "fiberStraightness": np.float64,
        "fringeSize": np.float64,
        "geodesicAspectRatio": np.float64,
        "geodesicLength": np.float64,
        "geodesicThickness": np.float64,
        "imageX": np.float64,
        "imageY": np.float64,
        "imageHeight": np.float64,
        "imageWidth": np.float64,
        "intensityCalImage": np.float64,
        "intensity": np.float64,
        "length": np.float64,
        "particlesPerChain": np.float64,
        "perimeter": np.float64,
        "ratioBlueGreen": np.float64,
        "ratioRedBlue": np.float64,
        "ratioRedGreen": np.float64,
        "rawArea": np.float64,
        "rawConvexHullArea": np.float64,
        "rawConvexPerimeter": np.float64,
        "rawFeretMax": np.float64,
        "rawFeretMean": np.float64,
        "rawFeretMin": np.float64,
        "rawFilledArea": np.float64,
        "rawLegendreMajor": np.float64,
        "rawLegendreMinor": np.float64,
        "rawPerimeter": np.float64,
        "rawSphereComplement": np.float64,
        "rawSphereUnknown": np.float64,
        "rawSphereVolume": np.float64,
        "roughness": np.float64,
        "scatterArea": np.float64,
        "scatterPeak": np.float64,
        "scatterWidth": np.float64,
        "score": np.float64,
        "sigmaIntensity": np.float64,
        "sphereComplement": np.float64,
        "sphereCount": np.float64,
        "sphereUnknown": np.float64,
        "sphereVolume": np.float64,
        "sumIntensity": np.float64,
        "symmetry": np.float64,
        "transparency": np.float64,
        "volumeABD": np.float64,
        "volumeESD": np.float64,
        "width": np.float64,
    },
    "edge": {"particle": (int, "REFERENCES particle(ID)"), "edges": bytearray},
    "particle_image": {"id": (int, "REFERENCES particle(ID)"), "image": bytearray},
    "lo_particle": {},
    "lo_context_history": {},
    "lo_calibration_history": {},
    "nano_2_particle_counts": {},
    "nano_2_cal_history": {}
}


def read_u64(readable):
    buf = readable.read(8)
    if len(buf) < 8:
        return None

    return struct.unpack("<Q", buf)[0]


def vbd_rows(vbd_readable, header_len):
    BS = 2000

    for str_len in vbd_string_offsets(vbd_readable, header_len):
        last_i = 0
        i = 0
        while i < str_len:
            itm = vbd_readable.read(min(i - str_len, BS))

            i += BS


def vbd_string_offsets(vbd_readable, header_len):

    vbd_readable.seek(header_len)

    while True:
        str_len = read_u64(vbd_readable)
        if str_len is None:
            break
        other_header = read_u64(vbd_readable)

        str_b = vbd_readable.read(str_len)

        yield str_len


def vbd_strings(vbd_readable, header_len):

    vbd_readable.seek(header_len)

    while True:
        str_len = read_u64(vbd_readable)
        if str_len is None:
            break
        other_header = read_u64(vbd_readable)

        str_b = vbd_readable.read(str_len)

        yield (str_len, other_header, str_b)

def make_db_tables(db):
    def make_db_column(colname, coltype):
            qualifiers = ""
            if type(coltype) == tuple:
                qualifiers += " " + coltype[1]
                coltype = coltype[0]
            col = {
                np.float64: "REAL",
                int: "INTEGER",
                str: "TEXT",
                bytearray: "BLOB",
                pd.Timestamp: "TEXT",
                pd.Timedelta: "TEXT",
                "percentage": "REAL",
                bool: "INTEGER",
            }
            return f"{colname} {col[coltype]}{qualifiers}"
    
    for tablename, tableschema in SCHEMA.items():
        cols = [make_db_column(k, v) for k, v in tableschema.items()]

        if len(cols) == 0:
            return

        db.execute(f"DROP TABLE IF EXISTS {tablename};")
        
        sql = f"CREATE TABLE {tablename} ({",".join(cols)});"
        db.execute(sql)
    db.commit()

def fixup_schema(schema):
    r = {
        "dtype": dict(),
        "converters": dict(),
        "parse_dates": []
    }

    for k, v in schema.items():
        if type(v) == tuple:
            v = v[0]
        
        if v == pd.Timestamp:
            r["dtype"][k] = str
            r["parse_dates"] += [k]
        elif v == pd.Timedelta:
            r["converters"][k] = lambda x: pd.to_timedelta(x)
        elif v == "percentage":
            r["converters"][k] = lambda x: pd.to_numeric(x.rstrip('%')) / 100.0
        elif v == bytearray:
            r["converters"][k] = lambda x: bytearray.fromhex(x[2:])
        else:
            r["dtype"][k] = v

    return r

def write_vbd_csvs(vbd_readable, header_len):
    fhandle = None

    for len, _unknown, string in vbd_strings(vbd_readable, header_len):
            if string.startswith(b"**") and string.endswith(b"**"):
                tablename = string[2:-2].decode()

                if f is not None: f.close()
                f = open(f"./csvs/{tablename}.csv", 'w')
            else:
                if f is not None: print(string.decode(), file=f)
    
    else:
        if f is not None:
            f.close()

def vbd_tables(vbd_readable, header_len=0x1E8):
    current = None
    tablename = None

    table_schema = None
    for len, _unknown, string in vbd_strings(vbd_readable, header_len):
        if string.startswith(b"**") and string.endswith(b"**"):
            if tablename is not None:
                yield (tablename, current if current is not None else pd.DataFrame())
            current = None
            tablename = string[2:-2].decode()
            table_schema = fixup_schema(SCHEMA[tablename])
        else:
            if current is None:
                current = pd.DataFrame([], columns=string.decode().split(","))
            else:
                next_row = pd.read_csv(BytesIO(string), names=current.columns, header=None, delimiter=",", **table_schema)

                # To avoid warnings about concatenation with empty entries, check 
                # for the case where the current table is empty, and in that case, 
                # just overwrite it.
                if current.size == 0:
                    current = next_row
                else: 
                    current = pd.concat([
                        current, 
                        next_row
                ])

    else:
        if tablename is not None:
            yield (tablename, current if current is not None else pd.DataFrame())

if __name__ == "__main__":
    import sys

    vbd_file = sys.argv[1]
    out_file = sys.argv[2]

    db = sqlite3.connect(out_file)

    make_db_tables(db)


    file_info = dict()
    with open(vbd_file, "rb") as vbd_bin:
        for t, f in vbd_tables(vbd_bin):
            print("Loaded table", t)

            if f.size == 0:
                print("WARNING: This table is empty, and as such, it CANNOT be put into the SQLite database.")
            else:
                f.to_sql(t, db, index=False, index_label=None, if_exists='append')

    db.commit()