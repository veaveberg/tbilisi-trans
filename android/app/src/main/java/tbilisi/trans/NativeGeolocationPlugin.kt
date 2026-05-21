package tbilisi.trans

import android.Manifest
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "NativeGeolocation",
    permissions = [
        Permission(
            alias = "location",
            strings = [
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ]
        )
    ]
)
class NativeGeolocationPlugin : Plugin(), SensorEventListener {

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private var locationCallback: LocationCallback? = null
    
    // Compass Sensors
    private var sensorManager: SensorManager? = null
    private var accelerometer: Sensor? = null
    private var magnetometer: Sensor? = null
    
    private val gravity = FloatArray(3)
    private val geomagnetic = FloatArray(3)
    private var hasGravity = false
    private var hasGeomagnetic = false
    
    private var isHeadingUpdatesActive = false
    private var lastReportedHeading = 0.0f
    private var lastHeadingEmitTime = 0L
    private var lastDeliveredLocation: Location? = null

    override fun load() {
        super.load()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(context)
        
        sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        magnetometer = sensorManager?.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        val permission = getPermissionState("location")
        val res = JSObject()
        res.put("location", if (permission == PermissionState.GRANTED) "granted" else if (permission == PermissionState.DENIED) "denied" else "prompt")
        call.resolve(res)
    }

    @PluginMethod
    fun getCurrentPosition(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionCallback")
            return
        }

        val enableHighAccuracy = call.getBoolean("enableHighAccuracy") ?: true
        val priority = if (enableHighAccuracy) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY

        try {
            fusedLocationClient.lastLocation
                .addOnSuccessListener { lastLoc: Location? ->
                    if (lastLoc != null) {
                        lastDeliveredLocation = lastLoc
                        call.resolve(serializePosition(lastLoc))
                        return@addOnSuccessListener
                    }

                    fusedLocationClient.getCurrentLocation(priority, null)
                        .addOnSuccessListener { location: Location? ->
                            if (location != null) {
                                lastDeliveredLocation = location
                                call.resolve(serializePosition(location))
                            } else {
                                call.reject("Unable to determine current location.", "LOCATION_UNAVAILABLE")
                            }
                        }
                        .addOnFailureListener { e ->
                            call.reject("Location failure: " + e.localizedMessage, "LOCATION_ERROR")
                        }
                }
                .addOnFailureListener { e ->
                    call.reject("Location failure: " + e.localizedMessage, "LOCATION_ERROR")
                }
        } catch (e: SecurityException) {
            call.reject("Location permission access denied.", "LOCATION_PERMISSION_DENIED")
        }
    }

    @PluginMethod
    fun watchPosition(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionCallback")
            return
        }

        val id = call.getString("id")
        if (id.isNullOrEmpty()) {
            call.reject("Missing watch id.", "WATCH_ID_REQUIRED")
            return
        }

        val enableHighAccuracy = call.getBoolean("enableHighAccuracy") ?: true
        val priority = if (enableHighAccuracy) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY

        val locationRequest = LocationRequest.Builder(priority, 1000L)
            .setMinUpdateIntervalMillis(500L)
            .setWaitForAccurateLocation(false)
            .build()

        activity.runOnUiThread {
            // Clean up active watch if duplicate id
            stopLocationUpdates()

            locationCallback = object : LocationCallback() {
                override fun onLocationResult(locationResult: LocationResult) {
                    val location = locationResult.lastLocation ?: return
                    lastDeliveredLocation = location
                    val data = JSObject()
                    data.put("id", id)
                    data.put("position", serializePosition(location))
                    notifyListeners("watchPosition", data)
                }
            }

            try {
                fusedLocationClient.requestLocationUpdates(
                    locationRequest,
                    locationCallback!!,
                    Looper.getMainLooper()
                )

                fusedLocationClient.lastLocation
                    .addOnSuccessListener { lastLoc: Location? ->
                        if (lastLoc != null && shouldEmitWarmStartLocation(lastLoc)) {
                            lastDeliveredLocation = lastLoc
                            val data = JSObject()
                            data.put("id", id)
                            data.put("position", serializePosition(lastLoc))
                            notifyListeners("watchPosition", data)
                        }
                    }

                val res = JSObject()
                res.put("id", id)
                call.resolve(res)
            } catch (e: SecurityException) {
                call.reject("Location permission access denied.", "LOCATION_PERMISSION_DENIED")
            }
        }
    }

    @PluginMethod
    fun clearWatch(call: PluginCall) {
        activity.runOnUiThread {
            stopLocationUpdates()
            call.resolve()
        }
    }

    @PluginMethod
    fun startHeadingUpdates(call: PluginCall) {
        if (sensorManager == null || accelerometer == null || magnetometer == null) {
            call.reject("Heading is not available on this device.", "HEADING_UNAVAILABLE")
            return
        }

        activity.runOnUiThread {
            isHeadingUpdatesActive = true
            sensorManager?.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI)
            sensorManager?.registerListener(this, magnetometer, SensorManager.SENSOR_DELAY_UI)
            call.resolve()
        }
    }

    @PluginMethod
    fun stopHeadingUpdates(call: PluginCall) {
        activity.runOnUiThread {
            isHeadingUpdatesActive = false
            sensorManager?.unregisterListener(this)
            call.resolve()
        }
    }

    // --- Permission Callback ---
    @PermissionCallback
    private fun locationPermissionCallback(call: PluginCall) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            val methodName = call.methodName
            if (methodName == "getCurrentPosition") {
                getCurrentPosition(call)
            } else if (methodName == "watchPosition") {
                watchPosition(call)
            } else {
                call.resolve()
            }
        } else {
            call.reject("Location permission denied.", "LOCATION_PERMISSION_DENIED")
        }
    }

    // --- SensorEventListener Implementation ---
    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null || !isHeadingUpdatesActive) return

        if (event.sensor.type == Sensor.TYPE_ACCELEROMETER) {
            System.arraycopy(event.values, 0, gravity, 0, event.values.size)
            hasGravity = true
        } else if (event.sensor.type == Sensor.TYPE_MAGNETIC_FIELD) {
            System.arraycopy(event.values, 0, geomagnetic, 0, event.values.size)
            hasGeomagnetic = true
        }

        if (hasGravity && hasGeomagnetic) {
            val r = FloatArray(9)
            val i = FloatArray(9)
            if (SensorManager.getRotationMatrix(r, i, gravity, geomagnetic)) {
                val orientation = FloatArray(3)
                SensorManager.getOrientation(r, orientation)
                val azimuth = orientation[0] // in radians
                var headingInDegrees = Math.toDegrees(azimuth.toDouble()).toFloat()
                headingInDegrees = (headingInDegrees + 360) % 360

                val now = System.currentTimeMillis()
                var delta = Math.abs(headingInDegrees - lastReportedHeading)
                if (delta > 180) {
                    delta = 360 - delta
                }

                // Throttle emission logic: at most once per 250ms or when heading shifts by at least 6 degrees
                if (delta >= 6.0f || (now - lastHeadingEmitTime) >= 250L) {
                    lastReportedHeading = headingInDegrees
                    lastHeadingEmitTime = now

                    val data = JSObject()
                    data.put("heading", headingInDegrees.toDouble())
                    data.put("accuracy", 15.0) // constant high-quality accuracy representation for JS bridge
                    notifyListeners("headingUpdate", data)
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        // No-op
    }

    // --- Private Helper Utilities ---
    private fun stopLocationUpdates() {
        locationCallback?.let {
            fusedLocationClient.removeLocationUpdates(it)
            locationCallback = null
        }
    }

    private fun shouldEmitWarmStartLocation(location: Location): Boolean {
        val previous = lastDeliveredLocation ?: return true
        val ageMs = System.currentTimeMillis() - location.time
        if (ageMs > 60_000L) return false
        return previous.distanceTo(location) > 5f || kotlin.math.abs(previous.time - location.time) > 1_000L
    }

    private fun serializePosition(location: Location): JSObject {
        val positionObj = JSObject()
        val coordsObj = JSObject()
        coordsObj.put("latitude", location.latitude)
        coordsObj.put("longitude", location.longitude)
        coordsObj.put("accuracy", location.accuracy.toDouble())
        coordsObj.put("altitude", location.altitude)
        coordsObj.put("altitudeAccuracy", 0.0) // Mocked, standard web fallback compatibility
        coordsObj.put("heading", if (location.hasBearing()) location.bearing.toDouble() else null)
        coordsObj.put("speed", if (location.hasSpeed()) location.speed.toDouble() else null)
        positionObj.put("coords", coordsObj)
        positionObj.put("timestamp", location.time)
        return positionObj
    }
}
